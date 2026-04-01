/**
 * Bootstrap Server — lightweight "phone book" for Relay discovery.
 *
 * Endpoints:
 *   POST /v1/relays/register   – Relay registration with Ed25519 signature verification
 *   POST /v1/relays/heartbeat  – Relay heartbeat update
 *   GET  /v1/relays            – List active Relays (scored / ranked)
 *   DELETE /v1/relays/:pubkey  – Deregister a Relay
 *   GET  /health               – Health endpoint
 */

import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { verify, fromHex } from '../crypto/index.js';
import { createLogger } from '../logger.js';
import type { BootstrapRelayEntry } from '../discovery/types.js';

const log = createLogger('bootstrap');

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

export function initDatabase(dbPath: string = ':memory:'): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_registry (
      relay_pubkey     TEXT PRIMARY KEY,
      relay_id         TEXT NOT NULL,
      endpoint         TEXT NOT NULL UNIQUE,
      models_supported TEXT NOT NULL,
      fee_pct          REAL NOT NULL DEFAULT 0.05,
      region           TEXT NOT NULL,
      capacity         INTEGER NOT NULL DEFAULT 0,
      version          TEXT NOT NULL,
      active_providers INTEGER NOT NULL DEFAULT 0,
      active_requests  INTEGER NOT NULL DEFAULT 0,
      uptime_seconds   INTEGER NOT NULL DEFAULT 0,
      registered_at    INTEGER NOT NULL,
      last_heartbeat   INTEGER NOT NULL,
      last_health_check INTEGER,
      health_latency_ms INTEGER,
      status           TEXT NOT NULL DEFAULT 'online'
                       CHECK(status IN ('online','stale','offline','banned')),
      witness_count    INTEGER NOT NULL DEFAULT 0,
      reputation_score REAL NOT NULL DEFAULT 50.0,
      total_uptime_pct REAL NOT NULL DEFAULT 100.0,
      ban_reason       TEXT,
      ban_until        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_relay_status ON relay_registry(status);
    CREATE INDEX IF NOT EXISTS idx_relay_region ON relay_registry(region);
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

function buildRegisterSignable(body: {
  relay_pubkey: string;
  endpoint: string;
  models_supported: string[];
  fee_pct: number;
  region: string;
  capacity: number;
  version: string;
  timestamp: number;
}): string {
  return JSON.stringify({
    relay_pubkey: body.relay_pubkey,
    endpoint: body.endpoint,
    models_supported: body.models_supported,
    fee_pct: body.fee_pct,
    region: body.region,
    capacity: body.capacity,
    version: body.version,
    timestamp: body.timestamp,
  });
}

function buildHeartbeatSignable(body: {
  relay_pubkey: string;
  models_supported: string[];
  capacity: number;
  fee_pct: number;
  active_providers: number;
  active_requests: number;
  uptime_seconds: number;
  timestamp: number;
}): string {
  return JSON.stringify({
    relay_pubkey: body.relay_pubkey,
    models_supported: body.models_supported,
    capacity: body.capacity,
    fee_pct: body.fee_pct,
    active_providers: body.active_providers,
    active_requests: body.active_requests,
    uptime_seconds: body.uptime_seconds,
    timestamp: body.timestamp,
  });
}

function verifySignature(signable: string, signature: string, pubkey: string): boolean {
  try {
    return verify(
      new TextEncoder().encode(signable),
      fromHex(signature),
      fromHex(pubkey),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Health-check & prune helpers (exported for testing / cron)
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_MS = 90_000;       // 90 s  → mark stale/offline
const PRUNE_THRESHOLD_MS = 24 * 3600_000; // 24 h → delete offline relays

/** Mark relays offline if no heartbeat for >90 s. */
export function runHealthCheck(db: Database.Database, now: number = Date.now()): void {
  const cutoff = now - STALE_THRESHOLD_MS;
  const updated = db.prepare(`
    UPDATE relay_registry
       SET status = 'offline'
     WHERE status IN ('online','stale')
       AND last_heartbeat < ?
  `).run(cutoff);
  if (updated.changes > 0) {
    log.info('health-check: marked relays offline', { count: updated.changes });
  }
}

/** Remove relays that have been offline >24 h. */
export function pruneOfflineRelays(db: Database.Database, now: number = Date.now()): void {
  const cutoff = now - PRUNE_THRESHOLD_MS;
  const removed = db.prepare(`
    DELETE FROM relay_registry
     WHERE status = 'offline'
       AND last_heartbeat < ?
  `).run(cutoff);
  if (removed.changes > 0) {
    log.info('prune: removed stale relays', { count: removed.changes });
  }
}

// ---------------------------------------------------------------------------
// Row → RelayInfo mapper
// ---------------------------------------------------------------------------

function rowToRelayInfo(r: BootstrapRelayEntry) {
  return {
    relay_pubkey: r.relay_pubkey,
    relay_id: r.relay_id,
    endpoint: r.endpoint,
    models_supported: JSON.parse(r.models_supported),
    fee_pct: r.fee_pct,
    region: r.region,
    capacity: r.capacity,
    active_providers: r.active_providers,
    reputation_score: r.reputation_score,
    uptime_pct: r.total_uptime_pct,
    witness_count: r.witness_count,
    health_latency_ms: r.health_latency_ms,
    version: r.version,
  };
}

// ---------------------------------------------------------------------------
// Hono app factory
// ---------------------------------------------------------------------------

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // ±5 min

export function createBootstrapApp(db: Database.Database) {
  const app = new Hono();

  // ----- POST /v1/relays/register -------------------------------------------
  app.post('/v1/relays/register', async (c) => {
    const body = await c.req.json();

    // Validate required fields
    if (!body.relay_pubkey || !body.endpoint || !body.signature) {
      return c.json({ status: 'rejected', reason: 'missing_fields' }, 400);
    }

    // Timestamp drift check
    if (Math.abs(Date.now() - body.timestamp) > TIMESTAMP_TOLERANCE_MS) {
      return c.json({ status: 'rejected', reason: 'timestamp_expired' }, 400);
    }

    // Verify Ed25519 signature
    const signable = buildRegisterSignable(body);
    if (!verifySignature(signable, body.signature, body.relay_pubkey)) {
      return c.json({ status: 'rejected', reason: 'invalid_signature' }, 401);
    }

    const now = Date.now();
    const relayId = body.relay_pubkey.substring(0, 16);

    try {
      db.prepare(`
        INSERT INTO relay_registry (
          relay_pubkey, relay_id, endpoint, models_supported, fee_pct,
          region, capacity, version, registered_at, last_heartbeat, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online')
        ON CONFLICT(relay_pubkey) DO UPDATE SET
          endpoint          = excluded.endpoint,
          models_supported  = excluded.models_supported,
          fee_pct           = excluded.fee_pct,
          region            = excluded.region,
          capacity          = excluded.capacity,
          version           = excluded.version,
          last_heartbeat    = excluded.last_heartbeat,
          status            = 'online'
      `).run(
        body.relay_pubkey,
        relayId,
        body.endpoint,
        JSON.stringify(body.models_supported ?? []),
        body.fee_pct ?? 0.05,
        body.region ?? 'unknown',
        body.capacity ?? 0,
        body.version ?? '0.1.0',
        now,
        now,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint failed: relay_registry.endpoint')) {
        return c.json({ status: 'rejected', reason: 'duplicate_endpoint' }, 409);
      }
      throw err;
    }

    log.info('relay registered', { relay_id: relayId, endpoint: body.endpoint });

    return c.json({
      status: 'accepted',
      relay_id: relayId,
      bootstrap_time: now,
      ttl_seconds: 120,
    });
  });

  // ----- POST /v1/relays/heartbeat ------------------------------------------
  app.post('/v1/relays/heartbeat', async (c) => {
    const body = await c.req.json();

    if (!body.relay_pubkey || !body.signature) {
      return c.json({ error: 'missing_fields' }, 400);
    }

    // Check relay exists
    const existing = db.prepare(
      'SELECT relay_pubkey FROM relay_registry WHERE relay_pubkey = ?',
    ).get(body.relay_pubkey) as { relay_pubkey: string } | undefined;

    if (!existing) {
      return c.json({ error: 'relay_not_found' }, 404);
    }

    // Verify signature
    const signable = buildHeartbeatSignable(body);
    if (!verifySignature(signable, body.signature, body.relay_pubkey)) {
      return c.json({ error: 'invalid_signature' }, 401);
    }

    const now = Date.now();
    db.prepare(`
      UPDATE relay_registry SET
        models_supported = ?,
        capacity         = ?,
        fee_pct          = ?,
        active_providers = ?,
        active_requests  = ?,
        uptime_seconds   = ?,
        last_heartbeat   = ?,
        status           = 'online'
      WHERE relay_pubkey = ?
    `).run(
      JSON.stringify(body.models_supported ?? []),
      body.capacity ?? 0,
      body.fee_pct ?? 0.05,
      body.active_providers ?? 0,
      body.active_requests ?? 0,
      body.uptime_seconds ?? 0,
      now,
      body.relay_pubkey,
    );

    log.debug('heartbeat received', { relay: body.relay_pubkey.substring(0, 16) });
    return c.json({ status: 'ok' });
  });

  // ----- GET /v1/relays -----------------------------------------------------
  app.get('/v1/relays', (c) => {
    // Run health check before listing
    runHealthCheck(db);

    const region = c.req.query('region');
    const model = c.req.query('model');
    const limit = Math.min(parseInt(c.req.query('limit') ?? '10', 10) || 10, 100);

    let query = `SELECT * FROM relay_registry WHERE status = 'online'`;
    const params: (string | number)[] = [];

    if (region) {
      query += ` AND region LIKE ?`;
      params.push(`${region}%`);
    }
    if (model) {
      query += ` AND models_supported LIKE ?`;
      params.push(`%${model}%`);
    }

    query += ` ORDER BY reputation_score DESC, health_latency_ms ASC NULLS LAST LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(query).all(...params) as BootstrapRelayEntry[];

    return c.json({
      relays: rows.map(rowToRelayInfo),
      cache_ttl_seconds: 60,
      bootstrap_version: '0.1.0',
    });
  });

  // ----- DELETE /v1/relays/:pubkey ------------------------------------------
  app.delete('/v1/relays/:pubkey', (c) => {
    const pubkey = c.req.param('pubkey');
    const result = db.prepare(
      'DELETE FROM relay_registry WHERE relay_pubkey = ?',
    ).run(pubkey);

    if (result.changes === 0) {
      return c.json({ error: 'relay_not_found' }, 404);
    }

    log.info('relay deregistered', { pubkey: pubkey.substring(0, 16) });
    return c.json({ status: 'deleted' });
  });

  // ----- GET /health --------------------------------------------------------
  app.get('/health', (c) => {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM relay_registry WHERE status = 'online'`,
    ).get() as { cnt: number };

    return c.json({
      status: 'ok',
      relays_online: row.cnt,
      version: '0.1.0',
    });
  });

  return app;
}
