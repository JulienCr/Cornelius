import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** Admin sessions survive restarts (replayable migration). Only the token hash is stored. */
export const adminSessionsMigration = `CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
) STRICT;`;

export const adminSessionSeconds = 3600;
export const maxAdminSessions = 64;
// Below this, a request skips the write: the sliding expiry and LRU order stay this precise.
const touchGranularityMs = 30_000;

export function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/**
 * Admin sessions with a sliding expiry, at most `maxAdminSessions` (least recently used evicted).
 * Methods that close sessions return their hashes so the caller can close their WebSockets.
 */
export class AdminSessions {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  isValid(token: string | undefined): boolean {
    if (!token) return false;
    const row = this.db
      .prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?')
      .get(sessionHash(token));
    return row !== undefined && Number(row.expires_at) > this.now();
  }

  /** Opens a session. @returns hashes of the sessions evicted to make room. */
  open(token: string): string[] {
    this.purgeExpired();
    const time = this.now();
    const evicted: string[] = [];
    while (this.count() >= maxAdminSessions) {
      const oldest = this.db
        .prepare('SELECT token_hash FROM admin_sessions ORDER BY last_used_at, rowid LIMIT 1')
        .get();
      const hash = String(oldest?.token_hash);
      this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hash);
      evicted.push(hash);
    }
    this.db
      .prepare('INSERT INTO admin_sessions (token_hash, expires_at, last_used_at) VALUES (?, ?, ?)')
      .run(sessionHash(token), time + adminSessionSeconds * 1000, time);
    return evicted;
  }

  /** Extends the session to one hour from now (skipped within `touchGranularityMs`). */
  touch(token: string): void {
    const time = this.now();
    this.db
      .prepare(
        'UPDATE admin_sessions SET expires_at = ?, last_used_at = ? WHERE token_hash = ? AND last_used_at <= ?',
      )
      .run(time + adminSessionSeconds * 1000, time, sessionHash(token), time - touchGranularityMs);
  }

  close(token: string): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sessionHash(token));
  }

  closeAllExcept(token: string | null): string[] {
    const keep = token ? sessionHash(token) : '';
    const rows = this.db
      .prepare('DELETE FROM admin_sessions WHERE token_hash <> ? RETURNING token_hash')
      .all(keep);
    return rows.map((row) => String(row.token_hash));
  }

  purgeExpired(): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(this.now());
  }

  private count(): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()?.n ?? 0);
  }
}
