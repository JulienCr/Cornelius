/**
 * Simulateur de satellite audio : parle le protocole des satellites (version 1) sans matériel.
 * Il envoie du silence au rythme d’un micro, puis l’enregistrement donné, affiche les
 * messages du serveur et enregistre la voix de Cornelius. Voir
 * docs/developpement/satellites-protocole.md.
 *
 *   pnpm exec tsx scripts/satellite-sim.ts --token <jeton> [--wav cornelius.wav] [--after 2]
 *     [--url ws://127.0.0.1:3000/satellite] [--fingerprint AA:BB:…] [--timeout 60]
 *     [--out data/satellite-sim.wav] [--wake-only]
 *
 * Avec --wav, la sortie vaut 0 si « Cornelius » est entendu (et, sans --wake-only, si la
 * conversation s’ouvre puis se ferme), 1 sinon. --wake-only s’arrête après la détection,
 * sans conversation ni appel à OpenAI.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TLSSocket } from 'node:tls';
import WebSocket from 'ws';

const RATE = 16000;
const FRAME_BYTES = 2560;
const FRAME_MS = 80;

function option(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  return index === -1 ? undefined : process.argv[index + 1];
}
const token = option('token') ?? process.env.CORNELIUS_SATELLITE_TOKEN;
const url = option('url') ?? 'ws://127.0.0.1:' + (process.env.PORT ?? 3000) + '/satellite';
const wavPath = option('wav');
const afterMs = Number(option('after') ?? 2) * 1000;
const timeoutMs = Number(option('timeout') ?? 60) * 1000;
const output = option('out') ?? 'data/satellite-sim.wav';
const wakeOnly = process.argv.includes('--wake-only');
const fingerprint = option('fingerprint')?.replace(/:/g, '').toUpperCase();
if (!token) {
  console.error('Jeton manquant : --token <jeton> ou CORNELIUS_SATELLITE_TOKEN.');
  process.exit(1);
}
if (url.startsWith('wss:') && !fingerprint) {
  console.error('wss:// demande --fingerprint (empreinte affichée dans Réseau local).');
  process.exit(1);
}

function readWav(path: string): Buffer {
  const file = readFileSync(path);
  if (file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('Fichier WAV attendu.');
  let offset = 12;
  let valid = false;
  while (offset + 8 <= file.length) {
    const id = file.toString('ascii', offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ')
      valid =
        file.readUInt16LE(body) === 1 &&
        file.readUInt16LE(body + 2) === 1 &&
        file.readUInt32LE(body + 4) === RATE &&
        file.readUInt16LE(body + 14) === 16;
    if (id === 'data') {
      if (!valid) throw new Error('WAV PCM 16 bits mono 16 kHz attendu.');
      return file.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  throw new Error('Données WAV introuvables.');
}

const speech = wavPath ? readWav(wavPath) : null;
const started = performance.now();
const at = () => (performance.now() - started) / 1000;
const log = (text: string) => console.log(at().toFixed(2).padStart(6) + ' s  ' + text);

let listening = false;
let speechAt: number | null = null;
let speechOffset = 0;
let heard = false;
let refused = false;
let conversed = false;
let firstAudible: number | null = null;
const voice: Buffer[] = [];

// Même seuil que le serveur : la voix de Live arrive en continu, silences compris.
function audible(pcm: Buffer): boolean {
  let energy = 0;
  let count = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 16) {
    const sample = pcm.readInt16LE(offset);
    energy += sample * sample;
    count++;
  }
  const rms = 0.007 * 32768;
  return count > 0 && energy / count >= rms * rms;
}

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
let streamTimer: ReturnType<typeof setTimeout> | null = null;

const socket = new WebSocket(url, {
  headers: { Authorization: 'Bearer ' + token },
  // Certificat auto-signé de Cornelius : vérifié par son empreinte, comme un vrai satellite.
  rejectUnauthorized: false,
});
socket.on('upgrade', (response) => {
  if (!fingerprint) return;
  const peer = (response.socket as TLSSocket).getPeerCertificate?.();
  if (peer?.fingerprint256?.replace(/:/g, '').toUpperCase() !== fingerprint) {
    log('Empreinte TLS inattendue : connexion abandonnée.');
    refused = true;
    socket.terminate();
  }
});
socket.on('unexpected-response', (_request, response) => {
  log('Connexion refusée (' + response.statusCode + ').');
  process.exit(1);
});
socket.on('open', () => {
  log('Connecté à ' + url);
  socket.send(JSON.stringify({ type: 'hello', protocol: 1, firmware: 'sim-0.1.0' }));
});

function nextFrame(): Buffer {
  const frame = Buffer.alloc(FRAME_BYTES);
  if (speech && speechAt !== null && speechOffset < speech.length) {
    speech.copy(frame, 0, speechOffset, Math.min(speechOffset + FRAME_BYTES, speech.length));
    speechOffset += FRAME_BYTES;
    if (speechOffset >= speech.length) log('Fin de l’enregistrement.');
  }
  return frame;
}

function stream() {
  // Rythme réel : une trame toutes les 80 ms, recalée sur l’horloge pour ne pas dériver.
  const begin = performance.now();
  let index = 0;
  const tick = () => {
    if (!listening || socket.readyState !== WebSocket.OPEN) return;
    if (speech && speechAt === null && performance.now() - begin >= afterMs) {
      speechAt = at();
      log('Lecture de ' + wavPath + ' (' + (speech.length / 2 / RATE).toFixed(2) + ' s).');
    }
    socket.send(nextFrame());
    index++;
    streamTimer = setTimeout(tick, Math.max(0, begin + index * FRAME_MS - performance.now()));
  };
  tick();
}

socket.on('message', (data, binary) => {
  if (binary) {
    const pcm = Buffer.from(data as Buffer);
    voice.push(pcm);
    if (firstAudible === null && audible(pcm)) {
      firstAudible = at();
      log('Cornelius parle.');
    }
    return;
  }
  const message = JSON.parse(String(data));
  if (message.type === 'welcome')
    log(
      'Accueilli : « ' +
        message.name +
        ' », volume ' +
        message.volume +
        ', protocole ' +
        message.protocol +
        '.',
    );
  else if (message.type === 'listen') {
    log(
      message.enabled
        ? 'Le serveur écoute : envoi du micro.'
        : 'Le serveur n’écoute pas : micro au repos.',
    );
    const wasListening = listening;
    listening = message.enabled === true;
    if (!listening && streamTimer) clearTimeout(streamTimer);
    if (listening && !wasListening) stream();
  } else if (message.type === 'wake') {
    heard = true;
    log('« Cornelius » entendu (score ' + message.score + ').');
    if (speech && wakeOnly) setTimeout(() => socket.close(1000), 1000);
  } else if (message.type === 'session') {
    log('Conversation : ' + message.state + '.');
    if (message.state === 'ready') conversed = true;
    if (message.state === 'closed' && speech) setTimeout(() => socket.close(1000), 300);
  } else if (message.type === 'busy') log('Occupé : la conversation ne s’ouvre pas ici.');
  else log('Message : ' + JSON.stringify(message));
});
socket.on('close', (code, reason) => {
  log('Fermé (' + code + (reason.length ? ' ' + reason : '') + ').');
  const pcm = Buffer.concat(voice);
  if (pcm.length) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, wav(pcm));
    log('Voix reçue : ' + (pcm.length / 2 / RATE).toFixed(2) + ' s → ' + output);
  }
  const failed = refused || (speech && (!heard || (!wakeOnly && !conversed)));
  process.exit(failed ? 1 : 0);
});
socket.on('error', (error) => log('Erreur : ' + error.message));
setTimeout(() => {
  log(speech ? 'Délai dépassé sans « Cornelius ».' : 'Fin de la simulation.');
  socket.close(1000);
}, timeoutMs).unref();
