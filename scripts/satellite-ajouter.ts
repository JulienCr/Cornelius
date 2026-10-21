/**
 * Crée l’accès d’un satellite audio configuré à la main (développement) et affiche son jeton,
 * montré une seule fois. Un satellite ordinaire s’associe dans Administration → Satellites audio.
 *
 *   pnpm exec tsx --env-file-if-exists=.env scripts/satellite-ajouter.ts "Bureau"
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../server/config.js';
import { keyFingerprintOf } from '../server/network.js';
import { openDatabase } from '../server/storage.js';
import { SATELLITE_NAME_MAX, SatelliteStore } from '../server/satellites-store.js';

const name = (process.argv[2] ?? '').trim();
if (!name || name.length > SATELLITE_NAME_MAX) {
  console.error(
    `Usage : satellite-ajouter.ts "<nom de la pièce, ${SATELLITE_NAME_MAX} caractères maximum>"`,
  );
  process.exit(1);
}
const config = loadConfig();
// Clé du certificat de Cornelius : celle de CORNELIUS_TLS_KEY, sinon celle qu’il a créée.
const keyFile = config.tlsKey ?? join(dirname(config.databasePath), 'tls', 'key.pem');
const keyFingerprint = existsSync(keyFile) ? keyFingerprintOf(readFileSync(keyFile, 'utf8')) : null;
const db = openDatabase(config.databasePath);
try {
  const { satellite, token } = new SatelliteStore(db, Date.now).create(name);
  console.log('Satellite « ' + satellite.name + ' » créé (' + satellite.id + ').');
  console.log('Jeton, à noter maintenant, il ne sera plus affiché :\n  ' + token);
  console.log('Depuis cet ordinateur : ws://127.0.0.1:' + config.port + '/satellite');
  if (config.lan)
    console.log(
      'Depuis le réseau local : wss://<adresse>:' +
        config.httpsPort +
        '/satellite' +
        (keyFingerprint ? '\nEmpreinte de la clé à vérifier :\n  ' + keyFingerprint : ''),
    );
} finally {
  db.close();
}
