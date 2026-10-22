import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** All domain records are versioned JSON; indexed fields stay queryable and constrained in SQLite. */
export class Store {
  readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      const migrations = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'").get();
      if (migrations) {
        const current = this.db.prepare('SELECT MAX(version) AS version FROM migrations').get() as { version: number | null };
        if (current.version !== null && ![0, 1, 2, 3].includes(current.version)) throw new Error(`Unsupported Bots database version ${current.version}`);
      }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS records_room ON records(kind,json_extract(data,'$.roomId'));
      CREATE INDEX IF NOT EXISTS messages_room_seq ON records(json_extract(data,'$.roomId'),json_extract(data,'$.seq')) WHERE kind='message';
      CREATE INDEX IF NOT EXISTS records_binding ON records(kind,json_extract(data,'$.bindingId'));
      CREATE INDEX IF NOT EXISTS context_binding_seq ON records(json_extract(data,'$.bindingId'),json_extract(data,'$.roomSeq')) WHERE kind='context';
      CREATE INDEX IF NOT EXISTS active_context_binding ON records(json_extract(data,'$.bindingId'),json_extract(data,'$.bindingGeneration'),json_extract(data,'$.roomSeq')) WHERE kind='context' AND json_extract(data,'$.status') IN ('pending','accepted','recovery_required');
      CREATE INDEX IF NOT EXISTS records_person ON records(kind,json_extract(data,'$.personId'));
      CREATE INDEX IF NOT EXISTS records_status ON records(kind,json_extract(data,'$.status'));
      CREATE UNIQUE INDEX IF NOT EXISTS active_session ON records(json_extract(data,'$.sessionId')) WHERE kind='binding' AND json_extract(data,'$.active')=1;
      CREATE UNIQUE INDEX IF NOT EXISTS active_room_bot ON records(json_extract(data,'$.roomId'),json_extract(data,'$.botId')) WHERE kind='binding' AND json_extract(data,'$.active')=1;
      CREATE UNIQUE INDEX IF NOT EXISTS message_idempotency ON records(json_extract(data,'$.deviceId'),json_extract(data,'$.clientMessageId')) WHERE kind='message' AND json_extract(data,'$.clientMessageId') IS NOT NULL;
      DROP INDEX IF EXISTS projection_source;
      DROP INDEX IF EXISTS projection_source_v2;
      CREATE UNIQUE INDEX IF NOT EXISTS projection_source_v3 ON records(json_extract(data,'$.bindingId'),json_extract(data,'$.sourceKey')) WHERE kind='projection';
      CREATE UNIQUE INDEX IF NOT EXISTS context_source ON records(json_extract(data,'$.bindingId'),json_extract(data,'$.bindingGeneration'),json_extract(data,'$.roomMessageId')) WHERE kind='context';
      CREATE TABLE IF NOT EXISTS events(room_id TEXT NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(room_id,seq));
      INSERT OR IGNORE INTO migrations(version) VALUES(1);
      INSERT OR IGNORE INTO migrations(version) VALUES(2);`);
    const version = this.db.prepare('SELECT MAX(version) AS version FROM migrations').get() as { version: number };
    if (version.version < 3) this.transaction(() => {
      // Remove the retired workspace/session grants and pairing credentials.
      // Rooms, memberships, selected Sessions, transcripts and task receipts stay intact.
      this.db.exec("DELETE FROM records WHERE kind IN ('workspace','session-access','ticket','receipt','credential'); INSERT INTO migrations(version) VALUES(3);");
    });
    } catch (error) { this.db.close(); throw error; }
  }
  /** Reuse compiled queries, never their results. Bound variable-shape IN queries too. */
  prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = this.db.prepare(sql);
    if (this.statements.size >= 64) this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(sql, statement);
    return statement;
  }
  meta(key: string): string | undefined { return (this.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  setMeta(key: string, value: string): void { this.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  get<T>(kind: string, id: string): T | undefined { const row = this.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id) as { data: string } | undefined; return row ? JSON.parse(row.data) as T : undefined; }
  put(kind: string, id: string, value: unknown): void { this.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, id, JSON.stringify(value)); }
  remove(kind: string, id: string): void { this.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  list<T>(kind: string, filter?: { field: string; value: string | number }): T[] {
    if (filter && !/^[A-Za-z][A-Za-z0-9]*$/.test(filter.field)) throw new Error('Invalid indexed record field');
    const rows = filter
      ? this.prepare(`SELECT data FROM records WHERE kind=? AND json_extract(data,'$.${filter.field}')=? ORDER BY rowid`).all(kind, filter.value)
      : this.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind);
    return (rows as { data: string }[]).map(row => JSON.parse(row.data) as T);
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  close(): void { this.statements.clear(); this.db.close(); }
}
