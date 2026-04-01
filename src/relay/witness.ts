import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sign, verify, toHex, fromHex } from '../crypto/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('witness');

export interface WitnessRecord {
  request_id: string;
  consumer_pubkey: string;
  provider_pubkey: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  duration_ms: number;
  timestamp: number;           // Unix ms
  relay_pubkey: string;
  relay_signature: string;     // hex, Ed25519 signature over the record
}

/**
 * Returns the canonical signable payload for a witness record.
 * Excludes relay_signature; all other fields are included in deterministic order.
 */
function signablePayload(record: Omit<WitnessRecord, 'relay_signature'>): string {
  return JSON.stringify({
    request_id: record.request_id,
    consumer_pubkey: record.consumer_pubkey,
    provider_pubkey: record.provider_pubkey,
    model: record.model,
    input_tokens: record.input_tokens,
    output_tokens: record.output_tokens,
    cache_read_tokens: record.cache_read_tokens ?? 0,
    cache_write_tokens: record.cache_write_tokens ?? 0,
    duration_ms: record.duration_ms,
    timestamp: record.timestamp,
    relay_pubkey: record.relay_pubkey,
  });
}

export class WitnessStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS witness (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        consumer_pubkey TEXT NOT NULL,
        provider_pubkey TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        relay_pubkey TEXT NOT NULL,
        relay_signature TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_witness_ts ON witness(timestamp);
      CREATE INDEX IF NOT EXISTS idx_witness_consumer ON witness(consumer_pubkey);
      CREATE INDEX IF NOT EXISTS idx_witness_provider ON witness(provider_pubkey);
      CREATE INDEX IF NOT EXISTS idx_witness_request ON witness(request_id);
    `);
  }

  /**
   * Record a completed request as a witness.
   * Signs the record with the relay's Ed25519 secret key.
   */
  record(
    params: Omit<WitnessRecord, 'relay_signature'>,
    relaySecretKey: Uint8Array,
  ): WitnessRecord {
    const payload = signablePayload(params);
    const signature = sign(new TextEncoder().encode(payload), relaySecretKey);
    const relay_signature = toHex(signature);

    const record: WitnessRecord = { ...params, relay_signature };

    this.db.prepare(`
      INSERT INTO witness (
        request_id, consumer_pubkey, provider_pubkey, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        duration_ms, timestamp, relay_pubkey, relay_signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.request_id,
      record.consumer_pubkey,
      record.provider_pubkey,
      record.model,
      record.input_tokens,
      record.output_tokens,
      record.cache_read_tokens ?? 0,
      record.cache_write_tokens ?? 0,
      record.duration_ms,
      record.timestamp,
      record.relay_pubkey,
      record.relay_signature,
    );

    log.info('witness_recorded', {
      request_id: record.request_id,
      model: record.model,
      input_tokens: record.input_tokens,
      output_tokens: record.output_tokens,
    });

    return record;
  }

  /**
   * Get a witness by request_id.
   */
  get(requestId: string): WitnessRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM witness WHERE request_id = ?',
    ).get(requestId) as Record<string, unknown> | undefined;

    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Verify a witness signature against a relay public key.
   */
  verify(witness: WitnessRecord, relayPublicKey: Uint8Array): boolean {
    const { relay_signature, ...rest } = witness;
    const payload = signablePayload(rest);
    try {
      return verify(
        new TextEncoder().encode(payload),
        fromHex(relay_signature),
        relayPublicKey,
      );
    } catch {
      return false;
    }
  }

  /**
   * List witnesses with optional filters and pagination.
   */
  list(opts?: {
    limit?: number;
    offset?: number;
    consumer?: string;
    provider?: string;
    since?: number;
  }): WitnessRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.consumer) {
      conditions.push('consumer_pubkey = ?');
      params.push(opts.consumer);
    }
    if (opts?.provider) {
      conditions.push('provider_pubkey = ?');
      params.push(opts.provider);
    }
    if (opts?.since) {
      conditions.push('timestamp >= ?');
      params.push(opts.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT * FROM witness ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Record<string, unknown>[];

    return rows.map((r) => this.rowToRecord(r));
  }

  /**
   * Get aggregate stats.
   */
  stats(opts?: {
    since?: number;
    consumer?: string;
    provider?: string;
  }): {
    total_requests: number;
    total_input_tokens: number;
    total_output_tokens: number;
    unique_consumers: number;
    unique_providers: number;
  } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.consumer) {
      conditions.push('consumer_pubkey = ?');
      params.push(opts.consumer);
    }
    if (opts?.provider) {
      conditions.push('provider_pubkey = ?');
      params.push(opts.provider);
    }
    if (opts?.since) {
      conditions.push('timestamp >= ?');
      params.push(opts.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(output_tokens), 0) as total_output_tokens,
        COUNT(DISTINCT consumer_pubkey) as unique_consumers,
        COUNT(DISTINCT provider_pubkey) as unique_providers
      FROM witness ${where}
    `).get(...params) as Record<string, number>;

    return {
      total_requests: row.total_requests,
      total_input_tokens: row.total_input_tokens,
      total_output_tokens: row.total_output_tokens,
      unique_consumers: row.unique_consumers,
      unique_providers: row.unique_providers,
    };
  }

  /**
   * Prune old records. Default retention: 30 days.
   * Returns count of records pruned.
   */
  prune(retentionMs: number = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - retentionMs;
    const result = this.db.prepare(
      'DELETE FROM witness WHERE timestamp < ?',
    ).run(cutoff);
    const count = result.changes;

    if (count > 0) {
      log.info('witness_pruned', { count, cutoff });
    }

    return count;
  }

  /**
   * Export witnesses as JSON array (for future on-chain migration).
   */
  export(opts?: { since?: number; limit?: number }): WitnessRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.since) {
      conditions.push('timestamp >= ?');
      params.push(opts.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 10000;

    const rows = this.db.prepare(
      `SELECT * FROM witness ${where} ORDER BY timestamp ASC LIMIT ?`,
    ).all(...params, limit) as Record<string, unknown>[];

    return rows.map((r) => this.rowToRecord(r));
  }

  checkpoint(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Best effort
    }
  }

  close(): void {
    this.db.close();
  }

  private rowToRecord(row: Record<string, unknown>): WitnessRecord {
    const record: WitnessRecord = {
      request_id: row.request_id as string,
      consumer_pubkey: row.consumer_pubkey as string,
      provider_pubkey: row.provider_pubkey as string,
      model: row.model as string,
      input_tokens: row.input_tokens as number,
      output_tokens: row.output_tokens as number,
      duration_ms: row.duration_ms as number,
      timestamp: row.timestamp as number,
      relay_pubkey: row.relay_pubkey as string,
      relay_signature: row.relay_signature as string,
    };

    const cacheRead = row.cache_read_tokens as number;
    const cacheWrite = row.cache_write_tokens as number;
    if (cacheRead > 0) record.cache_read_tokens = cacheRead;
    if (cacheWrite > 0) record.cache_write_tokens = cacheWrite;

    return record;
  }
}
