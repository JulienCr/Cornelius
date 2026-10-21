/**
 * Sonde des satellites (étape 0) : vérifie qu'une session Live tient sur un WebSocket principal
 * en PCM16 mono 16 kHz, dans les deux sens, comme le fera le relais des satellites.
 *
 *   pnpm exec tsx --env-file-if-exists=.env scripts/satellite-sonde.ts [entrée.wav] [sortie.wav]
 *
 * Avec un WAV (PCM16 mono 16 kHz), il est envoyé au rythme réel par trames de 80 ms, comme un
 * satellite, suivi de silence. Sans WAV, une consigne fait parler Cornelius. La réponse est
 * écrite dans data/satellite-sonde.wav ; chaque type d'événement reçu est listé, pour repérer
 * ceux qu'un satellite devra suivre (fin de réponse, interruption).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import OpenAI from 'openai';
import { LiveWS } from 'openai/resources/live/ws';

const RATE = 16000;
const FRAME_BYTES = 2560; // 80 ms : la trame de veille de Cornelius et d'openWakeWord
const FRAME_MS = 80;
const TRAILING_SILENCE_MS = 2000;
const QUIET_END_MS = 3000;
const TIMEOUT_MS = 45_000;

const input = process.argv[2];
const output = process.argv[3] ?? 'data/satellite-sonde.wav';
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY absente : renseignez-la dans .env.');
  process.exit(1);
}

function readWav(path: string): Buffer {
  const file = readFileSync(path);
  if (file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('Fichier WAV attendu.');
  let offset = 12;
  let format: { channels: number; rate: number; bits: number; tag: number } | null = null;
  while (offset + 8 <= file.length) {
    const id = file.toString('ascii', offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ')
      format = {
        tag: file.readUInt16LE(body),
        channels: file.readUInt16LE(body + 2),
        rate: file.readUInt32LE(body + 4),
        bits: file.readUInt16LE(body + 14),
      };
    if (id === 'data') {
      if (!format || format.tag !== 1 || format.channels !== 1 || format.rate !== RATE)
        throw new Error('WAV PCM mono 16 kHz attendu.');
      if (format.bits !== 16) throw new Error('WAV 16 bits attendu.');
      return file.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  throw new Error('Données WAV introuvables.');
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

const speech = input ? readWav(input) : null;
const started = performance.now();
const at = () => Math.round(performance.now() - started);
const seen = new Map<string, { first: number; count: number }>();
const transcripts = new Map<string, string>();
const audio: Buffer[] = [];
let sessionStartedAt: number | null = null;
let speechSentAt: number | null = null;
let firstAudioAt: number | null = null;
let firstAudibleAt: number | null = null;
let lastAudibleAt: number | null = null;
let finished = false;

// La sortie Live est un flux PCM continu, silences compris (même seuil que server/live).
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

const live = new LiveWS(new OpenAI({ apiKey }));

function finish(code: number, reason: string) {
  if (finished) return;
  finished = true;
  console.log('\n' + reason);
  const pcm = Buffer.concat(audio);
  if (pcm.length) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, wav(pcm));
  }
  console.log('\nÉvénements reçus (premier à, nombre) :');
  for (const [type, { first, count }] of [...seen].sort((a, b) => a[1].first - b[1].first))
    console.log('  ' + type.padEnd(40) + String(first).padStart(7) + ' ms  ×' + count);
  for (const [type, text] of transcripts) console.log('\n' + type + ' :\n  ' + text.trim());
  console.log('\nMesures :');
  console.log('  session démarrée      ' + (sessionStartedAt ?? '—') + ' ms');
  if (speechSentAt !== null) console.log('  fin de la parole      ' + speechSentAt + ' ms');
  if (firstAudioAt !== null) console.log('  premier flux reçu     ' + firstAudioAt + ' ms');
  if (firstAudibleAt !== null)
    console.log(
      '  premier son audible   ' +
        firstAudibleAt +
        ' ms' +
        (speechSentAt !== null ? ' (+' + (firstAudibleAt - speechSentAt) + ' ms)' : ''),
    );
  if (lastAudibleAt !== null) console.log('  dernier son audible   ' + lastAudibleAt + ' ms');
  const seconds = pcm.length / 2 / RATE;
  const deltas = seen.get('session.output_audio.delta')?.count ?? 0;
  if (deltas && firstAudioAt !== null)
    console.log(
      '  rythme du flux        ' +
        seconds.toFixed(2) +
        ' s de son en ' +
        ((at() - firstAudioAt) / 1000).toFixed(2) +
        ' s, ' +
        Math.round((seconds * 1000) / deltas) +
        ' ms par delta',
    );
  console.log('  réponse audio         ' + seconds.toFixed(2) + ' s → ' + output);
  live.close({ code: 1000, reason: 'sonde terminée' });
  setTimeout(() => process.exit(code), 200).unref();
}

async function sendSpeech() {
  const silence = Buffer.alloc(FRAME_BYTES);
  const frames: Buffer[] = [];
  for (let offset = 0; offset < speech!.length; offset += FRAME_BYTES) {
    const frame = Buffer.alloc(FRAME_BYTES);
    speech!.copy(frame, 0, offset, Math.min(offset + FRAME_BYTES, speech!.length));
    frames.push(frame);
  }
  for (let i = 0; i < TRAILING_SILENCE_MS / FRAME_MS; i++) frames.push(silence);
  const begin = performance.now();
  for (const [index, frame] of frames.entries()) {
    if (finished) return;
    live.send({ type: 'session.input_audio.append', audio: frame.toString('base64') });
    // Rythme réel, comme un micro : la trame suivante part 80 ms après la précédente.
    const wait = begin + (index + 1) * FRAME_MS - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (index === Math.ceil(speech!.length / FRAME_BYTES) - 1) speechSentAt = at();
  }
}

live.on('event', (event) => {
  const type = String(event.type);
  const entry = seen.get(type);
  if (entry) entry.count++;
  else seen.set(type, { first: at(), count: 1 });
  if (type === 'session.started') {
    sessionStartedAt = at();
    console.log('Session démarrée (' + sessionStartedAt + ' ms).');
    if (speech) void sendSpeech();
    else
      live.send({
        type: 'session.instructions.append',
        content: 'Accueil : dis exactement « Bonjour, je suis Cornelius. » puis écoute.',
        delegation_id: null,
      });
  } else if (type === 'session.output_audio.delta') {
    const pcm = Buffer.from((event as { delta: string }).delta, 'base64');
    audio.push(pcm);
    firstAudioAt ??= at();
    if (audible(pcm)) {
      firstAudibleAt ??= at();
      lastAudibleAt = at();
    }
  } else if (type.endsWith('transcript.delta')) {
    transcripts.set(type, (transcripts.get(type) ?? '') + (event as { delta: string }).delta);
  } else if (type === 'session.closed') {
    finish(0, 'Session close confirmée par OpenAI.');
  }
});
live.on('error', (error) => {
  console.error('Erreur Live :', error.message);
  finish(1, 'Arrêt sur erreur.');
});
live.on('close', (code, reason) =>
  finish(code === 1000 ? 0 : 1, 'WebSocket fermé (' + code + ' ' + reason + ').'),
);

live.send({
  type: 'session.start',
  session: {
    model: 'gpt-live-1',
    instructions:
      'Tu es Cornelius, l’assistant vocal de la maison. Parle français, avec chaleur et concision. Il n’y a pas d’écran : dis la réponse à voix haute.',
    audio: { format: { type: 'audio/pcm', rate: RATE }, output: { voice: 'cedar' } },
  },
});

// Fin : quelques secondes sans son après la réponse, ou délai maximal.
const watchdog = setInterval(() => {
  if (finished) return clearInterval(watchdog);
  const speechDone = !speech || speechSentAt !== null;
  if (speechDone && lastAudibleAt !== null && at() - lastAudibleAt > QUIET_END_MS) {
    clearInterval(watchdog);
    live.send({ type: 'session.close' });
    setTimeout(() => finish(0, 'Clôture demandée ; confirmation non reçue.'), 5000).unref();
  } else if (at() > TIMEOUT_MS) {
    clearInterval(watchdog);
    finish(1, 'Délai dépassé sans fin de réponse.');
  }
}, 250);
