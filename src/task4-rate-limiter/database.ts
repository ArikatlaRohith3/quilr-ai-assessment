import { DatabaseSync } from "node:sqlite";

/**
 * SQLite storage for token reservations (node:sqlite — built into Node 22.5+, no native deps).
 *
 * WAL + busy_timeout let several gateway processes share one database file;
 * reservations are written inside BEGIN IMMEDIATE transactions (see rate-limiter.ts).
 */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  // busy_timeout must be set first: the WAL switch itself takes a lock when processes open the file concurrently.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS token_reservations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,          -- epoch ms; the sliding window is keyed on this
      tokens      INTEGER NOT NULL CHECK (tokens >= 0),
      status      TEXT    NOT NULL CHECK (status IN ('reserved', 'committed', 'released'))
    );
    CREATE INDEX IF NOT EXISTS idx_reservations_tenant_time ON token_reservations (tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_reservations_time ON token_reservations (created_at);
  `);
  return db;
}
