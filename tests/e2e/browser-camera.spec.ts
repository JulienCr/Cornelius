import { test, expect, type WebSocketRoute } from '@playwright/test';
import type { StateEvent } from '../../shared/types';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test('browser camera requires a click, bounds frames until decode acknowledgement and releases capture', async ({
  page,
}) => {
  const snapshot = (await (await page.request.get('/api/state')).json()) as StateEvent;
  let events: WebSocketRoute | undefined;
  const config = {
    schemaVersion: 1,
    type: 'camera_config',
    source: 'browser',
    enabled: true,
    mode: { width: 640, height: 480, fps: 15 },
  };
  await page.routeWebSocket('**/events?role=kiosk', (route) => {
    events = route;
    route.send(JSON.stringify(snapshot));
    route.send(JSON.stringify(config));
  });
  let stream: WebSocketRoute | undefined;
  let frames = 0;
  let connections = 0;
  let lastSequence = 0;
  await page.routeWebSocket('**/camera-stream', (route) => {
    stream = route;
    connections++;
    route.send(JSON.stringify({ type: 'camera_ready' }));
    route.onMessage((data) => {
      expect(Buffer.isBuffer(data)).toBe(true);
      const frame = data as Buffer;
      expect(frame[0]).toBe(0x43);
      expect(frame.length).toBeLessThanOrEqual(250005);
      expect(frame[5]).toBe(255);
      expect(frame[6]).toBe(216);
      frames++;
      lastSequence = frame.readUInt32BE(1);
    });
  });
  await page.goto('/');
  await expect(page.getByText('Caméra de cet appareil', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /caméra/i })).toHaveCount(0);
  await expect.poll(() => frames).toBe(1);
  // Multiple capture ticks without an ACK must not send another image.
  await expect
    .poll(async () => page.locator('video').evaluate((v) => (v as HTMLVideoElement).currentTime))
    .toBeGreaterThan(0.5);
  expect(frames).toBe(1);
  stream!.send(JSON.stringify({ type: 'camera_ack', sequence: lastSequence }));
  await expect.poll(() => frames).toBe(2);
  stream!.close({ code: 1013 });
  await expect.poll(() => connections).toBe(2);
  await expect.poll(() => frames).toBe(3);
  events!.send(JSON.stringify({ ...config, enabled: false }));
  await expect
    .poll(() => page.locator('video').evaluate((v) => (v as HTMLVideoElement).srcObject === null))
    .toBe(true);
  events!.send(JSON.stringify(config));
  await expect.poll(() => frames).toBe(4);
  events!.send(JSON.stringify({ ...config, source: 'server', enabled: false }));
  await expect(page.locator('video')).toHaveCount(0);
});

test('browser camera lowers quality then size when frames exceed the limit, and reports it', async ({
  page,
}) => {
  const snapshot = (await (await page.request.get('/api/state')).json()) as StateEvent;
  // Any capture wider than 400 px encodes to an oversized blob, as a noisy Full HD scene would.
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (this.width <= 400) return original.call(this, callback, type, quality);
      callback(new Blob([new Uint8Array(260_000)], { type: 'image/jpeg' }));
    };
  });
  await page.routeWebSocket('**/events?role=kiosk', (route) => {
    route.send(JSON.stringify(snapshot));
    route.send(
      JSON.stringify({
        schemaVersion: 1,
        type: 'camera_config',
        source: 'browser',
        enabled: true,
        mode: { width: 640, height: 480, fps: 15 },
      }),
    );
  });
  const frames: Buffer[] = [];
  await page.routeWebSocket('**/camera-stream', (route) => {
    route.send(JSON.stringify({ type: 'camera_ready' }));
    route.onMessage((data) => frames.push(data as Buffer));
  });
  const reports: string[] = [];
  await page.route('**/api/client-logs', (route) => {
    reports.push(route.request().postData() ?? '');
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  const frame = frames[0]!;
  expect(frame.length).toBeLessThanOrEqual(250005);
  const sof = frame.findIndex(
    (byte, index) => byte === 0xff && (frame[index + 1] === 0xc0 || frame[index + 1] === 0xc2),
  );
  expect(frame.readUInt16BE(sof + 7)).toBeLessThanOrEqual(400);
  await expect.poll(() => reports.join('')).toContain('caméra du navigateur');
});
