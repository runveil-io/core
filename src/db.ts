import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function initDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      direction TEXT NOT NULL CHECK(direction IN ('outbound', 'inbound')),
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('ok', 'error', 'timeout')),
      error_code TEXT,
      provider_id TEXT,
      consumer_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_log(model);
    CREATE INDEX IF NOT EXISTS idx_usage_request ON usage_log(request_id);

    CREATE TABLE IF NOT EXISTS witness (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      consumer_hash TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      relay_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      relay_signature TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_witness_ts ON witness(timestamp);
    CREATE INDEX IF NOT EXISTS idx_witness_provider ON witness(provider_id);

    CREATE TABLE IF NOT EXISTS provider_state (
      provider_id TEXT PRIMARY KEY,
      encryption_pubkey TEXT NOT NULL,
      models TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 100,
      connected_at INTEGER NOT NULL,
      last_heartbeat INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('online', 'offline')) DEFAULT 'online'
    );

    CREATE INDEX IF NOT EXISTS idx_provider_status ON provider_state(status);
  `);

  return db;
}

export function checkpointAndClose(db: Database.Database): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Best effort — DB may already be closed or in error state
  }
  db.close();
}
