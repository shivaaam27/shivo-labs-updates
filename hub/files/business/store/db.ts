// The database file: Node's built-in SQLite (node:sqlite), plain SQL that also runs on Cloudflare D1 later.
// Migrations are numbered; meta_version remembers how many have run. Add new ones at the end, never edit old ones.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS: string[] = [
  // 1: the frame (FRAME.md "Storage")
  `CREATE TABLE docs (
     id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL,
     search TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, modified TEXT NOT NULL,
     owner TEXT, modified_by TEXT, deleted INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX docs_type_name ON docs(type, name);
   CREATE INDEX docs_type_title ON docs(type, title);
   CREATE TABLE links (from_type TEXT NOT NULL, from_id TEXT NOT NULL, field TEXT NOT NULL, to_type TEXT NOT NULL, to_id TEXT NOT NULL);
   CREATE INDEX links_to ON links(to_type, to_id);
   CREATE INDEX links_from ON links(from_type, from_id);
   CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, doc_id TEXT NOT NULL, action TEXT NOT NULL,
     by TEXT, at TEXT NOT NULL, before TEXT, after TEXT);
   CREATE INDEX log_doc ON log(type, doc_id);
   CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE series (prefix TEXT PRIMARY KEY, current INTEGER NOT NULL);
   CREATE TABLE steps (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, data TEXT NOT NULL,
     created TEXT NOT NULL, by TEXT);`,
  // 2: the screen's own id for each movement, so a retry after a timeout is saved once (review 13 Oct 2026)
  `ALTER TABLE steps ADD COLUMN client_id TEXT;
   CREATE UNIQUE INDEX steps_client ON steps (client_id) WHERE client_id IS NOT NULL;`,
];

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta_version (version INTEGER NOT NULL)');
  let row = db.prepare('SELECT version FROM meta_version').get() as { version: number } | undefined;
  if (!row) { db.prepare('INSERT INTO meta_version (version) VALUES (0)').run(); row = { version: 0 }; }
  for (let v = row.version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.prepare('UPDATE meta_version SET version = ?').run(v + 1);
    });
  }
}

/** Run fn inside one transaction; roll back on any error. Nested calls join the outer transaction. */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

export const now = (): string => new Date().toISOString();
