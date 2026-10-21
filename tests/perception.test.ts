import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { type TestContext } from 'node:test';
import type { WebSocket } from 'ws';
import { openDatabase, ProfileRepository } from '../server/storage.js';
import { SessionController } from '../server/controller.js';
import { PerceptionBridge } from '../server/perception.js';

class Worker extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: (string | Buffer)[] = [];
  send(value: string | Buffer) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  message(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)), false);
  }
  last() {
    return JSON.parse(String(this.sent.at(-1)));
  }
}
function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  let now = Date.now();
  const profiles = new ProfileRepository(db);
  const controller = new SessionController(profiles, { open() {}, close() {} }, () => now);
  const bridge = new PerceptionBridge(
    db,
    controller,
    () => {},
    () => now,
  );
  const worker = new Worker();
  bridge.connect(worker as unknown as WebSocket);
  t.after(() => {
    bridge.dispose();
    db.close();
  });
  let sequence = 0;
  const observe = (profileId: string | null = null) => {
    controller.heartbeat();
    worker.message({
      type: 'observation',
      observation: {
        schemaVersion: 1,
        producerBootId: 'camera',
        sequence: ++sequence,
        observedAt: now,
        health: 'ok',
        presence: true,
        engaged: true,
        people: [{ trackId: 'one', profileId }],
      },
    });
  };
  return {
    db,
    profiles,
    bridge,
    worker,
    controller,
    observe,
    advance(ms: number) {
      now += ms;
    },
    ready() {
      observe();
      now += 900;
      observe();
      controller.controlAttached(controller.scope());
      controller.sessionStarted(controller.scope());
      assert.equal(controller.snapshot().state.session.phase, 'ready');
      return controller.scope().interactionId!;
    },
  };
}
test('enrôlement explicite, signature normalisée, expiration et purge du profil', (t) => {
  const f = fixture(t);
  const profile = f.profiles.create('Test');
  f.bridge.enroll(profile.id);
  // Un message d’un ancien enregistrement est ignoré : l’enregistrement en cours continue.
  f.worker.message({
    type: 'enrolled',
    id: 'ancien',
    templates: Array.from({ length: 3 }, () => Array(128).fill(1)),
  });
  assert.equal(f.bridge.snapshot().enrollingProfileId, profile.id);
  assert.equal(f.bridge.snapshot().enrollmentResult, null);
  // Des vues inutilisables terminent l’enregistrement : le service de perception a arrêté le sien.
  for (const value of [
    { embedding: Array(127).fill(1) },
    { templates: Array.from({ length: 3 }, () => Array(128).fill(0)) },
    { templates: Array.from({ length: 3 }, () => Array(128).fill(1e308)) },
  ]) {
    f.bridge.enroll(profile.id);
    const { id } = f.worker.last().enrollment;
    f.worker.message({ type: 'enrolled', id, ...value });
    const snapshot = f.bridge.snapshot();
    assert.equal(snapshot.enrollingProfileId, null);
    assert.equal(snapshot.enrollmentResult?.outcome, 'rejected');
    assert.equal(snapshot.enrollmentResult?.id, id);
    assert.match(snapshot.enrollmentResult!.message, /Recommencez seul, face à la caméra/);
  }
  assert.deepEqual(f.bridge.snapshot().enrolledProfileIds, []);
  f.bridge.enroll(profile.id);
  const { id } = f.worker.last().enrollment;
  // Un nouvel enregistrement efface l’issue du précédent.
  assert.equal(f.bridge.snapshot().enrollmentResult, null);
  f.worker.message({
    type: 'enrolled',
    id,
    templates: Array.from({ length: 3 }, () => Array(128).fill(1)),
  });
  assert.deepEqual(f.bridge.snapshot().enrolledProfileIds, [profile.id]);
  assert.deepEqual(f.bridge.snapshot().enrollmentResult, {
    id,
    profileId: profile.id,
    mode: 'replace',
    outcome: 'saved',
    message: 'Visage mémorisé.',
    at: f.bridge.snapshot().enrollmentResult!.at,
  });
  const row = f.db.prepare('SELECT embedding FROM profile_faces').get()!;
  assert.ok(Math.abs(Math.hypot(...JSON.parse(String(row.embedding))) - 1) < 1e-10);
  f.bridge.forget(profile.id);
  assert.deepEqual(f.bridge.snapshot().enrolledProfileIds, []);
  // Le visage oublié ne laisse pas « Visage mémorisé » affiché.
  assert.equal(f.bridge.snapshot().enrollmentResult, null);
  f.bridge.enroll(profile.id);
  const expired = f.worker.last().enrollment.id;
  f.advance(90_001);
  f.worker.message({
    type: 'enrolled',
    id: expired,
    templates: Array.from({ length: 3 }, () => Array(128).fill(1)),
  });
  f.bridge.tick();
  assert.deepEqual(f.bridge.snapshot().enrolledProfileIds, []);
  assert.equal(f.bridge.snapshot().enrollmentResult?.outcome, 'expired');
  assert.equal(
    f.bridge.snapshot().enrollmentResult?.message,
    'Temps écoulé : recommencez seul, face à la caméra, bien éclairé.',
  );
  assert.equal(f.bridge.snapshot().diagnostic, null);
  f.bridge.enroll(profile.id);
  f.worker.message({
    type: 'enrolled',
    id: f.worker.last().enrollment.id,
    templates: Array.from({ length: 3 }, () => Array(128).fill(1)),
  });
  f.profiles.delete(profile.id);
  f.bridge.refreshProfiles();
  assert.deepEqual(f.bridge.snapshot().enrolledProfileIds, []);
  assert.deepEqual(f.worker.last().profiles, []);
});
test('en mode voix, la panne VAD ferme la session ; un ancien audio ne la prolonge pas', (t) => {
  const f = fixture(t);
  f.controller.setSessionMode(4);
  f.controller.setWakeWordAvailability(true, null);
  f.controller.heartbeat();
  assert.equal(f.controller.wakeDetected(), true);
  f.controller.controlAttached(f.controller.scope());
  f.controller.sessionStarted(f.controller.scope());
  const id = f.controller.scope().interactionId!;
  f.bridge.audio(id, Buffer.alloc(1024));
  assert.equal(f.worker.sent.at(-1) instanceof Buffer, true);
  f.worker.message({ type: 'vad', interactionId: id, speaking: false });
  f.advance(1500);
  f.controller.heartbeat();
  f.bridge.tick();
  assert.equal(f.controller.snapshot().state.session.phase, 'ready');
  f.worker.message({ type: 'vad', interactionId: 'ancien', speaking: true });
  f.advance(501);
  f.controller.heartbeat();
  f.bridge.tick();
  assert.equal(f.controller.snapshot().state.session.phase, 'closing');
  assert.match(f.controller.snapshot().state.session.reason!, /parole interrompue/);
});
test('dans les modes caméra, un VAD silencieux ne coupe pas la conversation', (t) => {
  const f = fixture(t);
  const id = f.ready();
  f.bridge.audio(id, Buffer.alloc(1024));
  f.advance(5000);
  f.observe();
  f.bridge.tick();
  assert.equal(f.controller.snapshot().state.session.phase, 'ready');
});
test('un profil inconnu du serveur ne peut pas être injecté par une observation', (t) => {
  const f = fixture(t);
  f.observe('profil-inexistant');
  const presence = f.controller.snapshot().state.presence;
  // L’image reste utile à la présence, mais la personne n’est pas reconnue.
  assert.equal(presence.peopleCount, 1);
  assert.deepEqual(presence.recognizedProfileIds, []);
  assert.equal(presence.people[0]?.profileId, null);
  const profile = f.profiles.create('Créé après coup');
  f.observe(profile.id);
  assert.deepEqual(f.controller.snapshot().state.presence.recognizedProfileIds, [profile.id]);
});

test('la tolérance est bornée, persistée et transmise au service local', (t) => {
  const f = fixture(t);
  assert.equal(f.bridge.snapshot().recognitionThreshold, 0.42);
  for (const value of [0.19, 0.9, NaN])
    assert.throws(() => f.bridge.setRecognitionThreshold(value));
  f.bridge.setRecognitionThreshold(0.2);
  assert.deepEqual(f.worker.last(), { type: 'recognition', threshold: 0.2 });
  assert.equal(
    f.db.prepare('SELECT recognition_threshold FROM camera_preferences').get()
      ?.recognition_threshold,
    0.2,
  );
  f.bridge.refreshProfiles();
  assert.equal(f.worker.last().recognitionThreshold, 0.2);
});

test('le suivi des visages reçoit les délais configurés et les retrouve après reconnexion', (t) => {
  const f = fixture(t);
  f.bridge.refreshProfiles();
  assert.equal(f.worker.last().trackingGraceMs, 8000);
  assert.equal(f.worker.last().identityHoldMs, 8000);
  f.controller.setPresenceTimings({
    ...f.controller.getPresenceTimings(),
    absenceMs: 1500,
    disengagementMs: 15000,
    identityHoldMs: 5000,
  });
  f.bridge.refreshPresenceTimings();
  assert.deepEqual(f.worker.last(), { type: 'tracking', graceMs: 15000, identityHoldMs: 5000 });
  const next = new Worker();
  f.bridge.connect(next as unknown as WebSocket);
  const profiles = next.sent
    .map((event) => JSON.parse(String(event)))
    .find((event) => event.type === 'profiles');
  assert.equal(profiles.trackingGraceMs, 15000);
  assert.equal(profiles.identityHoldMs, 5000);
});

test('les trois vues remplacent atomiquement l’ancien visage et la progression périmée est ignorée', (t) => {
  const f = fixture(t);
  const profile = f.profiles.create('Test');
  const vector = Array(128).fill(1);
  f.db
    .prepare('INSERT INTO profile_faces (profile_id, embedding, enrolled_at) VALUES (?, ?, ?)')
    .run(profile.id, JSON.stringify(vector), 1);
  f.bridge.refreshProfiles();
  assert.equal(f.worker.last().profiles[0].templates.length, 1);
  f.bridge.enroll(profile.id);
  const id = f.worker.last().enrollment.id;
  f.worker.message({
    type: 'enrollment_progress',
    id: 'old',
    step: 1,
    collected: 2,
    total: 5,
    message: 'Test',
  });
  assert.equal(f.bridge.snapshot().enrollmentProgress, null);
  f.worker.message({
    type: 'enrollment_progress',
    id,
    step: 1,
    collected: 2,
    total: 5,
    message: 'Autre côté',
  });
  assert.equal(f.bridge.snapshot().enrollmentProgress?.step, 1);
  for (const templates of [
    [vector],
    [vector, vector, Array(128).fill(0)],
    [vector, vector, Array(128).fill(-1)],
    [vector, vector, Array(127).fill(1)],
  ]) {
    f.bridge.enroll(profile.id);
    f.worker.message({ type: 'enrolled', id: f.worker.last().enrollment.id, templates });
    assert.equal(f.db.prepare('SELECT enrolled_at FROM profile_faces').get()?.enrolled_at, 1);
    // L’ancien visage reste ; l’administration apprend que le nouveau n’a pas été retenu.
    assert.equal(f.bridge.snapshot().enrollmentResult?.outcome, 'rejected');
    assert.equal(f.bridge.snapshot().enrolledProfileIds.length, 1);
  }
  f.bridge.enroll(profile.id);
  f.worker.message({
    type: 'enrolled',
    id: f.worker.last().enrollment.id,
    templates: [vector, vector, vector],
  });
  assert.equal(f.worker.last().profiles[0].templates.length, 3);
  assert.equal(f.bridge.snapshot().enrollmentProgress, null);
  f.bridge.forget(profile.id);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM profile_faces').get()?.count, 0);
});

test('l’engagement se règle indépendamment de l’identité et est transmis après reconnexion', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.bridge.snapshot().engagement, { poseTolerance: 0.3, minFaceRatio: 0.14 });
  for (const settings of [
    { poseTolerance: 0.6, minFaceRatio: 0.14 },
    { poseTolerance: 0.3, minFaceRatio: 0.01 },
    { poseTolerance: NaN, minFaceRatio: 0.14 },
  ])
    assert.throws(() => f.bridge.setEngagement(settings));
  const settings = { poseTolerance: 0.45, minFaceRatio: 0.08 };
  f.bridge.setEngagement(settings);
  assert.deepEqual(f.worker.last(), { type: 'engagement', settings });
  assert.equal(f.bridge.snapshot().recognitionThreshold, 0.42);
  assert.deepEqual(
    JSON.parse(
      String(
        f.db.prepare('SELECT engagement_settings FROM camera_preferences WHERE id = 1').get()
          ?.engagement_settings,
      ),
    ),
    settings,
  );
  f.bridge.refreshProfiles();
  assert.deepEqual(f.worker.last().engagement, settings);
});

test('veille : un emplacement par flux, trames bornées et détections périmées ignorées', (t) => {
  const f = fixture(t);
  f.worker.message({ type: 'wake_status', ready: true, detail: null });
  const heard: string[] = [];
  const starts = (worker: Worker) =>
    worker.sent
      .filter((value): value is string => typeof value === 'string')
      .map((value) => JSON.parse(value))
      .filter((event) => event.type === 'wake_start')
      .map((event) => [event.streamId, event.slot]);
  assert.equal(
    f.bridge.startWakeStream('mirror', (score) => heard.push('mirror ' + score)),
    true,
  );
  assert.equal(
    f.bridge.startWakeStream('satellite', (score) => heard.push('satellite ' + score)),
    true,
  );
  assert.deepEqual(starts(f.worker), [
    ['mirror', 0],
    ['satellite', 1],
  ]);
  f.bridge.wakeAudio('satellite', Buffer.alloc(12));
  f.bridge.wakeAudio('unknown', Buffer.alloc(2560));
  assert.equal(f.worker.sent.filter(Buffer.isBuffer).length, 0);
  f.bridge.wakeAudio('satellite', Buffer.alloc(2560));
  const frames = f.worker.sent.filter(Buffer.isBuffer);
  assert.equal(frames.length, 1);
  assert.deepEqual([frames[0]!.length, frames[0]![0], frames[0]![1]], [2562, 0x57, 1]);
  f.worker.message({ type: 'wake_detected', streamId: 'old', score: 0.9 });
  assert.deepEqual(heard, []);
  f.worker.message({ type: 'wake_detected', streamId: 'satellite', score: 0.9 });
  assert.deepEqual(heard, ['satellite 0.9']);
  // Un emplacement libéré est repris ; une perception relancée retrouve les flux ouverts.
  f.bridge.endWakeStream('mirror');
  f.bridge.startWakeStream('mirror-next', () => {});
  assert.deepEqual(starts(f.worker).at(-1), ['mirror-next', 0]);
  assert.equal(f.bridge.wakeStreamCount(), 2);
  const restarted = new Worker();
  f.bridge.connect(restarted as unknown as WebSocket);
  assert.deepEqual(starts(restarted), [
    ['satellite', 1],
    ['mirror-next', 0],
  ]);
});

const unit = (index: number) => Array.from({ length: 128 }, (_, i) => (i === index ? 1 : 0));

test('compléter un visage ajoute des vues, l’annulation libère la caméra', (t) => {
  const f = fixture(t);
  const profile = f.profiles.create('Sacha');
  assert.throws(() => f.bridge.enroll(profile.id, 'add'), /Aucun visage à compléter/);
  f.bridge.enroll(profile.id);
  f.worker.message({
    type: 'enrolled',
    id: f.worker.last().enrollment.id,
    templates: Array.from({ length: 6 }, () => unit(0)),
  });
  assert.deepEqual(
    f.bridge.snapshot().faces?.map((face) => face.views),
    [6],
  );
  f.bridge.enroll(profile.id, 'add');
  assert.equal(f.bridge.snapshot().enrollmentMode, 'add');
  const { id } = f.worker.last().enrollment;
  // Un autre visage ne peut pas compléter ce profil.
  f.worker.message({ type: 'enrolled', id, templates: Array.from({ length: 6 }, () => unit(1)) });
  assert.deepEqual(
    f.bridge.snapshot().faces?.map((face) => face.views),
    [6],
  );
  assert.equal(f.bridge.snapshot().enrollmentResult?.outcome, 'rejected');
  assert.equal(f.bridge.snapshot().enrollmentResult?.mode, 'add');
  assert.match(f.bridge.snapshot().enrollmentResult!.message, /déjà mémorisé/);
  f.bridge.enroll(profile.id, 'add');
  f.worker.message({
    type: 'enrolled',
    id: f.worker.last().enrollment.id,
    templates: Array.from({ length: 6 }, () => unit(0)),
  });
  assert.deepEqual(
    f.bridge.snapshot().faces?.map((face) => face.views),
    [12],
  );
  f.bridge.enroll(profile.id, 'add');
  f.worker.message({
    type: 'enrollment_progress',
    id: f.worker.last().enrollment.id,
    step: 1,
    collected: 4,
    total: 6,
    message: 'Tournez légèrement la tête vers un côté.',
  });
  assert.equal(f.bridge.snapshot().enrollmentProgress?.total, 6);
  f.bridge.cancelEnrollment();
  assert.equal(f.bridge.snapshot().enrollingProfileId, null);
  assert.equal(f.worker.last().type, 'profiles');
  assert.equal(f.worker.last().enrollment, null);
  // Annuler un « Compléter » n’annonce pas un visage mémorisé.
  assert.equal(f.bridge.snapshot().enrollmentResult?.outcome, 'cancelled');
});

test('l’issue d’un enregistrement : annulation, coupure, caméra éteinte et oubli après dix minutes', (t) => {
  const f = fixture(t);
  const profile = f.profiles.create('Camille');
  const other = f.profiles.create('Robin');
  f.bridge.enroll(profile.id);
  f.bridge.cancelEnrollment();
  assert.equal(f.bridge.snapshot().enrollmentResult?.outcome, 'cancelled');
  // Sans enregistrement en cours, annuler ne change pas l’issue précédente.
  f.bridge.enroll(other.id);
  f.worker.message({
    type: 'enrolled',
    id: f.worker.last().enrollment.id,
    templates: Array.from({ length: 3 }, () => unit(2)),
  });
  f.bridge.cancelEnrollment();
  assert.equal(f.bridge.snapshot().enrollmentResult?.outcome, 'saved');
  assert.equal(f.bridge.snapshot().enrollmentResult?.profileId, other.id);
  // La caméra s’éteint (passage à « Cornelius » pour tout le monde) pendant l’enregistrement.
  f.bridge.enroll(profile.id);
  f.bridge.setCameraEnabled(false);
  assert.equal(f.bridge.snapshot().enrollingProfileId, null);
  assert.equal(f.bridge.snapshot().enrollmentResult?.outcome, 'rejected');
  assert.match(f.bridge.snapshot().enrollmentResult!.message, /caméra s’est éteinte/);
  f.bridge.setCameraEnabled(true);
  // Le service de perception s’arrête pendant l’enregistrement.
  f.bridge.enroll(profile.id);
  f.worker.close();
  assert.equal(f.bridge.snapshot().enrollingProfileId, null);
  assert.equal(f.bridge.snapshot().enrollmentResult?.outcome, 'rejected');
  assert.match(f.bridge.snapshot().enrollmentResult!.message, /service caméra \(perception\)/);
  // L’issue reste lisible dix minutes, puis disparaît.
  f.advance(9 * 60_000);
  f.bridge.tick();
  assert.equal(f.bridge.snapshot().enrollmentResult?.outcome, 'rejected');
  f.advance(60_000);
  f.bridge.tick();
  assert.equal(f.bridge.snapshot().enrollmentResult, null);
});

test('la suppression du profil efface l’issue de son dernier enregistrement', (t) => {
  const f = fixture(t);
  const profile = f.profiles.create('Camille');
  f.bridge.enroll(profile.id);
  f.profiles.delete(profile.id);
  f.bridge.refreshProfiles();
  assert.equal(f.bridge.snapshot().enrollingProfileId, null);
  assert.equal(f.bridge.snapshot().enrollmentResult, null);
});

test('les profils ressemblants sont signalés et les scores en direct sont relayés', (t) => {
  const f = fixture(t);
  const sacha = f.profiles.create('Sacha');
  const frere = f.profiles.create('Frère');
  const close = unit(0).map((value, index) => (index === 1 ? 0.8 : value * 0.6));
  for (const [profile, vector] of [
    [sacha, unit(0)],
    [frere, close],
  ] as const) {
    f.bridge.enroll(profile.id);
    f.worker.message({
      type: 'enrolled',
      id: f.worker.last().enrollment.id,
      templates: Array.from({ length: 3 }, () => vector),
    });
  }
  assert.deepEqual(f.bridge.snapshot().lookalikes, [
    { profileIds: [sacha.id, frere.id], similarity: 0.6 },
  ]);
  assert.equal(f.bridge.recognitionLive(), null);
  assert.equal(f.worker.last().type, 'recognition_debug');
  f.worker.message({
    type: 'recognition_live',
    observedAt: 1,
    threshold: 0.42,
    faces: [
      {
        identity: sacha.id,
        usable: true,
        issue: null,
        required: 0.16,
        scores: [
          { profileId: sacha.id, score: 0.62 },
          { profileId: 'inconnu', score: 0.9 },
          { profileId: frere.id, score: 0.48 },
        ],
      },
    ],
  });
  assert.deepEqual(f.bridge.recognitionLive()?.faces[0]?.scores, [
    { profileId: sacha.id, score: 0.62 },
    { profileId: frere.id, score: 0.48 },
  ]);
  f.advance(2500);
  assert.equal(f.bridge.recognitionLive(), null);
});

test('la progression accepte les cinq positions, haut et bas compris', (t) => {
  const f = fixture(t);
  const profile = f.profiles.create('Test');
  f.bridge.enroll(profile.id);
  const { id } = f.worker.last().enrollment;
  const progress = (step: number) =>
    f.worker.message({
      type: 'enrollment_progress',
      id,
      step,
      collected: 2,
      total: 6,
      message: 'Baissez légèrement le menton.',
    });
  progress(4);
  assert.equal(f.bridge.snapshot().enrollmentProgress?.step, 4);
  progress(5);
  assert.equal(f.bridge.snapshot().enrollmentProgress?.step, 4);
  f.worker.message({ type: 'enrolled', id, templates: Array.from({ length: 10 }, () => unit(0)) });
  assert.deepEqual(
    f.bridge.snapshot().faces?.map((face) => face.views),
    [10],
  );
});

test('réglage depuis l’administration : la caméra reste allumée, puis la règle reprend', (t) => {
  const f = fixture(t);
  f.bridge.setCameraPolicy(() => false);
  const toggles = () =>
    f.worker.sent
      .filter((value) => typeof value === 'string')
      .map((value) => JSON.parse(value as string) as { type: string; enabled?: boolean })
      .filter((event) => event.type === 'camera_enabled')
      .map((event) => event.enabled);
  assert.equal(f.bridge.camera.isSuspended(), true);
  assert.equal(f.bridge.snapshot().camera.suspended, true);
  f.bridge.holdCamera(45_000);
  assert.equal(f.bridge.camera.isSuspended(), false);
  assert.equal(toggles().at(-1), true);
  // Renouvelé tant que la page est ouverte : aucun va-et-vient.
  f.advance(30_000);
  f.bridge.holdCamera(45_000);
  f.advance(30_000);
  f.bridge.tick();
  assert.equal(f.bridge.camera.isSuspended(), false);
  // Page fermée : la caméra s’éteint seule à la fin du maintien.
  f.advance(20_000);
  f.bridge.tick();
  assert.equal(f.bridge.camera.isSuspended(), true);
  assert.deepEqual(toggles().slice(-2), [true, false]);
});

test('mode voix : la caméra s’allume avec la conversation et s’éteint après, une seule fois', (t) => {
  const f = fixture(t);
  let wanted = false;
  f.bridge.setCameraPolicy(() => wanted);
  const toggles = () =>
    f.worker.sent
      .filter((value) => typeof value === 'string')
      .map((value) => JSON.parse(value as string) as { type: string; enabled?: boolean })
      .filter((event) => event.type === 'camera_enabled')
      .map((event) => event.enabled);
  assert.deepEqual(toggles(), [true, false]);
  assert.equal(f.bridge.camera.isSuspended(), true);
  f.bridge.syncCamera();
  assert.deepEqual(toggles(), [true, false], 'aucun envoi sans changement');
  wanted = true;
  f.bridge.syncCamera();
  f.bridge.syncCamera();
  assert.deepEqual(toggles(), [true, false, true]);
  assert.equal(f.bridge.camera.isSuspended(), false);
  wanted = false;
  f.bridge.syncCamera();
  assert.deepEqual(toggles(), [true, false, true, false]);
  // Une reconnexion du worker applique directement la règle courante.
  const worker = new (f.worker.constructor as new () => typeof f.worker)();
  f.bridge.connect(worker as unknown as WebSocket);
  const first = worker.sent
    .filter((value) => typeof value === 'string')
    .map((value) => JSON.parse(value as string) as { type: string; enabled?: boolean })
    .find((event) => event.type === 'camera_enabled');
  assert.equal(first?.enabled, false);
});

test('browser source: no enabled camera event until the worker confirms the source', (t) => {
  const f = fixture(t);
  type CameraEvent = { type: string; enabled?: boolean; deviceId?: string };
  const events = (worker: Worker) =>
    worker.sent
      .filter((value) => typeof value === 'string')
      .map((value) => JSON.parse(value as string) as CameraEvent)
      .filter((event) => event.type === 'camera_enabled' || event.type === 'camera_source');
  const forBrowser = (worker: Worker) =>
    events(worker).filter((event) => event.enabled && event.deviceId === 'browser');
  f.bridge.setCameraSource('browser');
  assert.equal(forBrowser(f.worker).length, 0, 'an older worker would open its own camera');
  assert.equal(events(f.worker).at(-1)?.enabled, false, 'its server camera is released');
  f.worker.message({ type: 'camera_source_status', source: 'browser' });
  assert.equal(forBrowser(f.worker).length, 1);
  // A reconnecting worker is held back the same way until it answers.
  const next = new Worker();
  f.bridge.connect(next as unknown as WebSocket);
  assert.equal(forBrowser(next).length, 0);
  assert.equal(events(next).at(-1)?.enabled, false);
  next.message({ type: 'camera_source_status', source: 'browser' });
  assert.equal(forBrowser(next).length, 1);
  // The confirmation does not turn on a camera that the policy does not want.
  f.bridge.setCameraPolicy(() => false);
  const count = events(next).length;
  next.message({ type: 'camera_source_status', source: 'browser' });
  assert.equal(events(next).length, count);
});
