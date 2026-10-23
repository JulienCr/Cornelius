import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import type { AppConfig } from '../server/config.js';

const origin = 'http://localhost';
const password = 'mot-de-passe-test-1234';
const minute = 60 * 1000;

async function fixture(t: TestContext, overrides: Partial<AppConfig> = {}) {
  const imageRoot = mkdtempSync(join(tmpdir(), 'cornelius-session-images-'));
  let now = Date.parse('2026-09-16T12:00:00Z');
  const services = await createApp(
    {
      databasePath: ':memory:',
      openaiKey: 'test-key',
      perceptionToken: 'p'.repeat(40),
      imageGenerationToken: 'i'.repeat(40),
      adminPassword: password,
      origins: [origin],
      secureCookies: false,
      ...overrides,
    } satisfies AppConfig,
    { timers: false, imageGenerationRoot: imageRoot, now: () => now },
  );
  await services.app.ready();
  t.after(async () => {
    await services.app.close();
    rmdirSync(imageRoot);
  });
  return {
    ...services,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function login(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin },
    payload: { password },
  });
  assert.equal(response.statusCode, 200, response.body);
  const entry = response.cookies.find((cookie) => cookie.name === 'cornelius_admin');
  assert.ok(entry);
  assert.equal(entry.maxAge, 3600);
  return `${entry.name}=${entry.value}`;
}

test('la session administrateur se prolonge à chaque requête et expire après une heure d’inactivité', async (t) => {
  const f = await fixture(t);
  const cookie = await login(f);
  const profiles = () => f.app.inject({ url: '/api/admin/profiles', headers: { cookie } });

  // Trois quarts d’heure d’activité régulière : bien au-delà de l’heure fixe d’avant.
  for (let step = 0; step < 3; step++) {
    f.advance(45 * minute);
    const response = await profiles();
    assert.equal(response.statusCode, 200, `requête ${step + 1}`);
    // Le cookie du navigateur est prolongé avec la session.
    const renewed = response.cookies.find((entry) => entry.name === 'cornelius_admin');
    assert.ok(renewed);
    assert.equal(`${renewed.name}=${renewed.value}`, cookie);
    assert.equal(renewed.maxAge, 3600);
  }

  // La vérification d’identité de la page compte aussi comme une activité.
  f.advance(59 * minute);
  assert.deepEqual(
    (await f.app.inject({ url: '/api/auth?role=admin', headers: { cookie } })).json(),
    { role: 'admin' },
  );

  // Une heure sans requête : la session est fermée, et la requête refusée ne la prolonge pas.
  f.advance(60 * minute);
  const expired = await profiles();
  assert.equal(expired.statusCode, 401);
  assert.equal(
    expired.cookies.some((entry) => entry.name === 'cornelius_admin'),
    false,
  );
  assert.deepEqual(
    (await f.app.inject({ url: '/api/auth?role=admin', headers: { cookie } })).json(),
    { role: null },
  );
});

test('une requête sur une adresse introuvable note le chemin dans le journal, sans paramètres', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({ url: '/page-inexistante?jeton=secret' });
  assert.equal(response.statusCode, 404);
  const entry = f.logs
    .snapshot()
    .entries.find((item) => item.source === 'http' && item.details.status === 404);
  assert.ok(entry, 'entrée http de la 404');
  assert.equal(entry.level, 'warn');
  assert.equal(entry.details.url, '/page-inexistante');
  assert.equal(JSON.stringify(entry).includes('secret'), false);

  // Les autres erreurs n’ajoutent pas d’adresse.
  await f.app.inject({ url: '/api/admin/profiles' });
  const refused = f.logs
    .snapshot()
    .entries.find((item) => item.source === 'http' && item.details.status === 401);
  assert.ok(refused);
  assert.equal('url' in refused.details, false);
});

test('au-delà de 64 sessions, une connexion ferme la moins récemment utilisée au lieu d’être refusée', async (t) => {
  // 65 connexions de suite : la limite de fréquence des connexions n’est pas le sujet ici.
  const f = await fixture(t, { loginRateLimit: 100 });
  const profiles = (cookie: string) =>
    f.app.inject({ url: '/api/admin/profiles', headers: { cookie } });
  const first = await login(f);
  const second = await login(f);
  for (let index = 2; index < 64; index++) await login(f);
  // La première session sert encore : c’est la deuxième, inactive, qui devient la plus ancienne.
  f.advance(minute);
  assert.equal((await profiles(first)).statusCode, 200);

  // 65ᵉ connexion avec le bon mot de passe : acceptée.
  const latest = await login(f);
  assert.equal((await profiles(latest)).statusCode, 200);
  assert.equal((await profiles(second)).statusCode, 401);
  assert.equal((await profiles(first)).statusCode, 200);
  assert.ok(
    f.logs
      .snapshot()
      .entries.some((entry) => entry.event === 'Session administrateur la plus ancienne fermée'),
  );
});

test('la session administrateur survit à un redémarrage du serveur, sans stocker le jeton', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cornelius-session-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'cornelius.sqlite');
  const before = await fixture(t, { databasePath });
  const cookie = await login(before);
  const token = cookie.split('=')[1]!;
  await before.app.close();

  const raw = new DatabaseSync(databasePath);
  const rows = raw.prepare('SELECT * FROM admin_sessions').all();
  raw.close();
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes(token), false);

  const after = await fixture(t, { databasePath });
  const profiles = () => after.app.inject({ url: '/api/admin/profiles', headers: { cookie } });
  assert.equal((await profiles()).statusCode, 200);
  assert.deepEqual(
    (await after.app.inject({ url: '/api/auth?role=admin', headers: { cookie } })).json(),
    { role: 'admin' },
  );

  // L’horloge simulée de la nouvelle instance repart à la date d’origine : une heure plus tard
  // sans requête, la session de la base est expirée.
  after.advance(61 * minute);
  assert.equal((await profiles()).statusCode, 401);

  const again = await login(after);
  await after.app.close();
  const third = await fixture(t, { databasePath });
  const listing = () =>
    third.app.inject({ url: '/api/admin/profiles', headers: { cookie: again } });
  assert.equal((await listing()).statusCode, 200);
  await third.app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { cookie: again, origin },
    payload: {},
  });
  await third.app.close();
  const fourth = await fixture(t, { databasePath });
  assert.equal(
    (await fourth.app.inject({ url: '/api/admin/profiles', headers: { cookie: again } }))
      .statusCode,
    401,
  );
  // t.after hooks run in registration order: the directory removal above runs before the
  // fixtures' own close, so every app must be closed here first.
  await fourth.app.close();
});

test('un mot de passe .env modifié ferme les sessions au redémarrage, le même les garde', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cornelius-session-rotation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'cornelius.sqlite');
  const first = await fixture(t, { databasePath });
  const cookie = await login(first);
  await first.app.close();

  const same = await fixture(t, { databasePath });
  const profiles = (f: typeof same) =>
    f.app.inject({ url: '/api/admin/profiles', headers: { cookie } });
  assert.equal((await profiles(same)).statusCode, 200);
  await same.app.close();

  const rotated = await fixture(t, { databasePath, adminPassword: 'autre-mot-de-passe-5678' });
  assert.equal((await profiles(rotated)).statusCode, 401);
  await rotated.app.close();

  const raw = new DatabaseSync(databasePath);
  const stamp = raw.prepare('SELECT hash FROM admin_env_stamp').all();
  raw.close();
  assert.equal(stamp.length, 1);
  assert.equal(JSON.stringify(stamp).includes('autre-mot-de-passe'), false);
});
