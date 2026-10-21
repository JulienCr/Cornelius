// Met à jour, dans THIRD_PARTY_NOTICES.md, la liste des bibliothèques npm installées par
// pnpm install --frozen-lockfile (pnpm-lock.yaml) et leur licence.
// Usage : pnpm notices (après un changement de dépendances). --check échoue si la liste est périmée.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');
const file = join(root, 'THIRD_PARTY_NOTICES.md');
const start = '<!-- npm:début -->';
const end = '<!-- npm:fin -->';

type Deps = Record<string, string | { version: string }>;
interface Lock {
  importers: Record<string, { dependencies?: Deps; optionalDependencies?: Deps }>;
  snapshots: Record<string, { dependencies?: Deps; optionalDependencies?: Deps }>;
  packages: Record<string, { bundledDependencies?: string[] }>;
}

// Strips the peer suffix: "react-dom@19.3.0(react@19.3.0)" -> "react-dom@19.3.0".
const bare = (key: string): string => key.replace(/\(.*$/, '');

function splitKey(key: string): [string, string] {
  const at = bare(key).lastIndexOf('@');
  return [key.slice(0, at), key.slice(at + 1).replace(/\(.*$/, '')];
}

function productionKeys(lock: Lock): Set<string> {
  const seen = new Set<string>();
  const visit = (name: string, dep: string | { version: string }): void => {
    const version = typeof dep === 'string' ? dep : dep.version;
    const key = `${name}@${version}`;
    if (seen.has(key) || !lock.snapshots[key]) return;
    seen.add(key);
    const snapshot = lock.snapshots[key];
    for (const group of [snapshot.dependencies, snapshot.optionalDependencies]) {
      for (const [child, v] of Object.entries(group ?? {})) visit(child, v);
    }
  };
  const importer = lock.importers['.'];
  for (const group of [importer?.dependencies, importer?.optionalDependencies]) {
    for (const [name, dep] of Object.entries(group ?? {})) visit(name, dep);
  }
  return new Set([...seen].map(bare));
}

function licenseOf(manifest: { license?: unknown; licenses?: unknown }): string | undefined {
  const text = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    const type = (value as { type?: unknown } | null | undefined)?.type;
    return typeof type === 'string' ? type : undefined;
  };
  const list = [manifest.license, manifest.licenses].find(Array.isArray);
  if (list) {
    const names = list.map(text).filter((name): name is string => !!name);
    return names.length > 0 ? names.join(' OR ') : undefined;
  }
  return text(manifest.license);
}

function installedLicenses(): Map<string, string> {
  const store = join(root, 'node_modules', '.pnpm');
  const licenses = new Map<string, string>();
  if (!existsSync(store)) return licenses;
  for (const dir of readdirSync(store)) {
    const at = dir.indexOf('@', 1);
    if (at < 0) continue;
    const name = dir.slice(0, at).replace('+', '/');
    const version = dir.slice(at + 1).replace(/_.*$/, '');
    const manifest = join(store, dir, 'node_modules', name, 'package.json');
    if (!existsSync(manifest)) continue;
    const license = licenseOf(JSON.parse(readFileSync(manifest, 'utf8')));
    if (license) licenses.set(`${name}@${version}`, license);
  }
  return licenses;
}

// Installed manifest of a package, or of a dependency bundled inside its tarball.
function installedManifest(
  parent: string,
  name: string,
): { version?: string; license?: string } | undefined {
  const [parentName, parentVersion] = splitKey(parent);
  const dir = `${parentName.replace('/', '+')}@${parentVersion}`;
  const manifest = join(root, 'node_modules', '.pnpm', dir, 'node_modules', name, 'package.json');
  if (!existsSync(manifest)) return undefined;
  const json = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
  return { version: json.version, license: licenseOf(json) };
}

export function npmNotices(): string {
  const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')) as Lock;
  const production = productionKeys(lock);
  const installed = installedLicenses();
  // Optional platform packages missing from node_modules take the licence of the installed
  // package that lists them as an optional dependency (esbuild, rollup, lightningcss...).
  const optionalParent = new Map<string, string>();
  for (const [snapshot, entry] of Object.entries(lock.snapshots)) {
    for (const [child, v] of Object.entries(entry.optionalDependencies ?? {})) {
      const version = typeof v === 'string' ? v : v.version;
      optionalParent.set(`${child}@${version}`, bare(snapshot));
    }
  }
  const rows = new Map<string, { name: string; version: string; line: string }>();
  const add = (name: string, version: string, license: string, role: string): void => {
    rows.set(`${name}@${version}`, {
      name,
      version,
      line: `| ${name} | ${version} | ${license} | ${role} |`,
    });
  };
  for (const snapshot of Object.keys(lock.snapshots)) {
    const key = bare(snapshot);
    if (rows.has(key)) continue;
    const [name, version] = splitKey(key);
    const parent = optionalParent.get(key);
    const license =
      installed.get(key) ?? (parent ? installed.get(parent) : undefined) ?? 'voir le paquet';
    add(name, version, license, production.has(key) ? 'exécution' : 'outil');
  }
  // Bundled dependencies have no snapshot and no version in the lockfile.
  for (const [pkg, entry] of Object.entries(lock.packages)) {
    const parent = bare(pkg);
    for (const name of entry.bundledDependencies ?? []) {
      const found = installedManifest(parent, name);
      const version = found?.version ?? `inclus dans ${parent}`;
      add(
        name,
        version,
        found?.license ?? 'voir le paquet',
        production.has(parent) ? 'exécution' : 'outil',
      );
    }
  }
  const sorted = [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    start,
    '| Paquet | Version | Licence | Rôle |',
    '| --- | --- | --- | --- |',
    ...sorted.map(([, row]) => row.line),
    end,
  ].join('\n');
}

function updated(text: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to < from) throw new Error(`Marqueurs ${start} et ${end} introuvables.`);
  return text.slice(0, from) + npmNotices() + text.slice(to + end.length);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const current = readFileSync(file, 'utf8');
  const next = updated(current);
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error('THIRD_PARTY_NOTICES.md est périmé : lancez pnpm notices.');
      process.exit(1);
    }
  } else {
    writeFileSync(file, next);
    console.info('THIRD_PARTY_NOTICES.md mis à jour.');
  }
}
