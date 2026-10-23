import assert from 'node:assert/strict';
import test from 'node:test';
import type { LogEntry } from '../shared/logs.js';
import {
  ALL_SOURCES,
  filterLog,
  levelLabels,
  logSources,
  logSummary,
  sourceLabel,
} from '../web/components/admin/log-view.js';

let id = 0;
function entry(partial: Partial<LogEntry>): LogEntry {
  return {
    id: ++id,
    time: '2026-10-06T09:00:00.000Z',
    level: 'info',
    source: 'local',
    event: 'Événement',
    details: {},
    ...partial,
  };
}

const saved = entry({
  source: 'http',
  event: 'Requête locale terminée',
  details: { method: 'POST', route: '/api/admin/profiles', status: 200 },
});
const missing = entry({
  source: 'http',
  level: 'warn',
  event: 'Requête locale terminée',
  details: { method: 'GET', route: '/*', url: '/page-inexistante', status: 404 },
});
const microphone = entry({
  source: 'navigateur',
  level: 'error',
  event: 'Diagnostic navigateur',
  details: { stage: 'microphone test', name: 'NotAllowedError', message: 'Autorisation refusée' },
});
const started = entry({ source: 'session', event: 'État du contrôleur' });
const all = [saved, missing, microphone, started];

test('niveaux et origines du journal en français', () => {
  assert.deepEqual(levelLabels, { info: 'Info', warn: 'Attention', error: 'Erreur' });
  assert.equal(sourceLabel('http'), 'Requêtes au serveur');
  assert.equal(sourceLabel('perception'), 'Périphériques');
  assert.equal(sourceLabel('local'), 'Serveur');
  assert.equal(sourceLabel('outil'), 'Outils');
  assert.equal(sourceLabel('inconnue'), 'Inconnue');
  assert.deepEqual(logSources(all), ['session', 'navigateur', 'http']);
});

test('les requêtes réussies sont masquées par défaut, pas les requêtes en échec', () => {
  const filter = { source: ALL_SOURCES, problemsOnly: false, search: '' };
  // Plus récente d’abord.
  assert.deepEqual(filterLog(all, filter), [started, microphone, missing]);
  assert.deepEqual(filterLog(all, { ...filter, source: 'http' }), [missing, saved]);
  assert.deepEqual(filterLog(all, { ...filter, problemsOnly: true }), [microphone, missing]);
});

test('la recherche porte sur les détails et sur les libellés affichés', () => {
  const filter = { source: ALL_SOURCES, problemsOnly: false, search: '' };
  assert.deepEqual(filterLog(all, { ...filter, search: 'notallowed' }), [microphone]);
  assert.deepEqual(filterLog(all, { ...filter, search: 'Attention' }), [missing]);
  assert.deepEqual(filterLog(all, { ...filter, search: 'conversation' }), [started]);
});

test('le résumé d’une ligne dit l’erreur ou la requête concernée', () => {
  assert.equal(logSummary(microphone), 'microphone test · NotAllowedError : Autorisation refusée');
  assert.equal(logSummary(missing), 'GET /page-inexistante · 404');
  assert.equal(logSummary(saved), 'POST /api/admin/profiles · 200');
  assert.equal(
    logSummary(entry({ details: { error: { name: 'TypeError', message: 'fetch failed' } } })),
    'TypeError : fetch failed',
  );
  assert.equal(logSummary(started), '');
});
