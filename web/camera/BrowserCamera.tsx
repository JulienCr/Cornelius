import { useEffect, useRef, useState } from 'react';
import { Video } from 'lucide-react';
import {
  BROWSER_CAMERA_ENCODING_STEPS,
  BROWSER_CAMERA_MAX_BYTES,
  encodeBrowserCameraFrame,
  type BrowserCameraConfig,
} from '../../shared/camera';
import { reportDiagnostic } from '../diagnostics';

/** Capture owned by the active mirror. A small corner icon replaces a webcam's LED while it runs. */
export function BrowserCamera({
  config,
  active,
}: {
  config: BrowserCameraConfig | null;
  active: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [capturing, setCapturing] = useState(false);
  const enabled = active && config?.source === 'browser' && config.enabled;
  const width = config?.mode.width ?? 1280;
  const height = config?.mode.height ?? 720;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let stream: MediaStream | null = null;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let encoding = false;
    let awaiting: { sequence: number; at: number } | null = null;
    let sequence = crypto.getRandomValues(new Uint32Array(1))[0]!;
    let retryMs = 500;
    let step = 0;
    let exhausted = false;
    const video = videoRef.current!;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const release = () => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      video.srcObject = null;
      setCapturing(false);
    };
    const connect = () => {
      if (disposed) return;
      const current = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/camera-stream`,
      );
      socket = current;
      awaiting = null;
      connectTimer = setTimeout(() => current.close(), 10_000);
      current.onmessage = ({ data }) => {
        if (disposed || socket !== current) return;
        try {
          const event = JSON.parse(String(data));
          if (event.type === 'camera_ready') {
            clearTimeout(connectTimer);
            retryMs = 500;
          }
          if (event.type === 'camera_ack' && event.sequence === awaiting?.sequence) awaiting = null;
        } catch {
          current.close(1003);
        }
      };
      current.onclose = (event) => {
        clearTimeout(connectTimer);
        if (disposed || socket !== current) return;
        awaiting = null;
        if (event.code === 1008) return void release();
        retry = setTimeout(connect, retryMs + Math.random() * 200);
        retryMs = Math.min(retryMs * 2, 8000);
      };
      current.onerror = () => current.close();
    };
    const tick = () => {
      if (disposed) return;
      timer = setTimeout(tick, 100);
      if (awaiting && Date.now() - awaiting.at > 5000) return void socket?.close();
      if (
        !context ||
        encoding ||
        awaiting ||
        video.readyState < 2 ||
        socket?.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount > 0
      )
        return;
      const settings = BROWSER_CAMERA_ENCODING_STEPS[step]!;
      const scale =
        Math.min(1, width / video.videoWidth, height / video.videoHeight) * settings.scale;
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const current = socket;
      encoding = true;
      canvas.toBlob(
        (blob) => {
          void (async () => {
            try {
              if (blob && blob.size > BROWSER_CAMERA_MAX_BYTES) {
                // Dropping every frame would leave perception without images.
                const kb = Math.round(blob.size / 1000);
                const next = BROWSER_CAMERA_ENCODING_STEPS[step + 1];
                if (next) {
                  step++;
                  reportDiagnostic(
                    'warn',
                    `caméra du navigateur : image de ${kb} Ko, qualité ${Math.round(next.quality * 100)} %, taille ${Math.round(next.scale * 100)} %`,
                  );
                } else if (!exhausted) {
                  exhausted = true;
                  reportDiagnostic(
                    'error',
                    `caméra du navigateur : image de ${kb} Ko, réduction épuisée`,
                  );
                }
                return;
              }
              if (!blob || disposed || socket !== current || current.readyState !== WebSocket.OPEN)
                return;
              const image = await blob.arrayBuffer();
              if (disposed || socket !== current || current.readyState !== WebSocket.OPEN) return;
              sequence = (sequence + 1) >>> 0;
              const frame = encodeBrowserCameraFrame(image, sequence);
              awaiting = { sequence, at: Date.now() };
              current.send(frame);
            } finally {
              encoding = false;
            }
          })();
        },
        'image/jpeg',
        settings.quality,
      );
    };
    void (async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !context) return;
        const captured = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            width: { ideal: width },
            height: { ideal: height },
            frameRate: { ideal: 15, max: 30 },
          },
        });
        if (disposed) return void captured.getTracks().forEach((track) => track.stop());
        stream = captured;
        for (const track of captured.getVideoTracks()) track.onended = release;
        video.srcObject = captured;
        await video.play();
        if (!disposed) {
          setCapturing(true);
          connect();
          tick();
        }
      } catch {
        if (!disposed) release();
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(retry);
      clearTimeout(connectTimer);
      socket?.close();
      release();
    };
  }, [enabled, width, height]);
  return config?.source === 'browser' ? (
    <>
      <video ref={videoRef} muted playsInline className="sr-only" aria-hidden="true" />
      {capturing && (
        <span
          className="mirror-camera-indicator"
          role="status"
          aria-label="Caméra de cet appareil active"
        >
          <Video aria-hidden="true" />
        </span>
      )}
    </>
  ) : null;
}
