import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBootstrapApp, initDatabase, runHealthCheck, pruneOfflineRelays } from '../src/bootstrap/server.js';
import { sign, toHex, generateSigningKeyPair } from '../src/crypto/index.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeyPair() {
  const kp = generateSigningKeyPair();
  return { pubkey: toHex(kp.publicKey), secretKey: kp.secretKey, publicKey: kp.publicKey };
}

function signRegisterPayload(body: Record<string, unknown>, secretKey: Uint8Array): string {
  const signable = JSON.stringify({
    relay_pubkey: body.relay_pubkey,
    endpoint: body.endpoint,
    models_supported: body.models_supported,
    fee_pct: body.fee_pct,
    region: body.region,
    capacity: body.capacity,
    version: body.version,
    timestamp: body.timestamp,
  });
  return toHex(sign(new TextEncoder().encode(signable), secretKey));
}

function signHeartbeatPayload(body: Record<string, unknown>, secretKey: Uint8Array): string {
  const signable = JSON.stringify({
    relay_pubkey: body.relay_pubkey,
    models_supported: body.models_supported,
    capacity: body.capacity,
    fee_pct: body.fee_pct,
    active_providers: body.active_providers,
    active_requests: body.active_requests,
    uptime_seconds: body.uptime_seconds,
    timestamp: body.timestamp,
  });
  return toHex(sign(new TextEncoder().encode(signable), secretKey));
}

function makeRegisterBody(kp: ReturnType<typeof makeKeyPair>, overrides: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    relay_pubkey: kp.pubkey,
    endpoint: `wss://relay-${kp.pubkey.substring(0, 8)}.example.com`,
    models_supported: ['claude-sonnet-4-20250514'],
    fee_pct: 0.05,
    region: 'JP-Tokyo',
    capacity: 10,
    version: '0.1.0',
    timestamp: Date.now(),
    ...overrides,
  };
  body.signature = signRegisterPayload(body, kp.secretKey);
  return body;
}

// ---------------------------------------------------------------------------
// Test helpers – use Hono's built-in request method
// ---------------------------------------------------------------------------

let db: Database.Database;
let app: ReturnType<typeof createBootstrapApp>;

beforeEach(() => {
  db = initDatabase(':memory:');
  app = createBootstrapApp(db);
});

afterEach(() => {
  db.close();
});

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/relays/register', () => {
  it('accepts a valid registration', async () => {
    const kp = makeKeyPair();
    const body = makeRegisterBody(kp);
    const res = await req('POST', '/v1/relays/register', body);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('accepted');
    expect(json.relay_id).toBe(kp.pubkey.substring(0, 16));
    expect(json.ttl_seconds).toBe(120);
  });

  it('rejects invalid signature', async () => {
    const kp = makeKeyPair();
    const body = makeRegisterBody(kp);
    // Corrupt the signature
    body.signature = 'ff'.repeat(64);

    const res = await req('POST', '/v1/relays/register', body);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.reason).toBe('invalid_signature');
  });

  it('rejects signature from wrong key', async () => {
    const kp1 = makeKeyPair();
    const kp2 = makeKeyPair();
    // Sign with kp2 but claim kp1 pubkey
    const body: Record<string, unknown> = {
      relay_pubkey: kp1.pubkey,
      endpoint: 'wss://relay-wrongkey.example.com',
      models_supported: ['claude-sonnet-4-20250514'],
      fee_pct: 0.05,
      region: 'US-Virginia',
      capacity: 5,
      version: '0.1.0',
      timestamp: Date.now(),
    };
    body.signature = signRegisterPayload(body, kp2.secretKey);

    const res = await req('POST', '/v1/relays/register', body);
    expect(res.status).toBe(401);
  });

  it('rejects expired timestamp', async () => {
    const kp = makeKeyPair();
    const body = makeRegisterBody(kp, { timestamp: Date.now() - 10 * 60 * 1000 });

    const res = await req('POST', '/v1/relays/register', body);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe('timestamp_expired');
  });

  it('allows re-registration (upsert) with same pubkey', async () => {
    const kp = makeKeyPair();
    const body1 = makeRegisterBody(kp, { capacity: 5 });
    const body2 = makeRegisterBody(kp, { capacity: 20 });

    await req('POST', '/v1/relays/register', body1);
    const res = await req('POST', '/v1/relays/register', body2);
    expect(res.status).toBe(200);

    // List should show updated capacity
    const listRes = await req('GET', '/v1/relays');
    const list = await listRes.json();
    expect(list.relays).toHaveLength(1);
    expect(list.relays[0].capacity).toBe(20);
  });
});

describe('POST /v1/relays/heartbeat', () => {
  it('updates relay fields on heartbeat', async () => {
    const kp = makeKeyPair();
    await req('POST', '/v1/relays/register', makeRegisterBody(kp));

    const hbBody: Record<string, unknown> = {
      relay_pubkey: kp.pubkey,
      models_supported: ['claude-sonnet-4-20250514', 'gpt-4o'],
      capacity: 50,
      fee_pct: 0.03,
      active_providers: 5,
      active_requests: 2,
      uptime_seconds: 3600,
      timestamp: Date.now(),
    };
    hbBody.signature = signHeartbeatPayload(hbBody, kp.secretKey);

    const res = await req('POST', '/v1/relays/heartbeat', hbBody);
    expect(res.status).toBe(200);

    const listRes = await req('GET', '/v1/relays');
    const list = await listRes.json();
    expect(list.relays[0].capacity).toBe(50);
    expect(list.relays[0].fee_pct).toBe(0.03);
    expect(list.relays[0].models_supported).toContain('gpt-4o');
  });

  it('rejects heartbeat for unknown relay', async () => {
    const kp = makeKeyPair();
    const hbBody: Record<string, unknown> = {
      relay_pubkey: kp.pubkey,
      models_supported: [],
      capacity: 1,
      fee_pct: 0.05,
      active_providers: 0,
      active_requests: 0,
      uptime_seconds: 0,
      timestamp: Date.now(),
    };
    hbBody.signature = signHeartbeatPayload(hbBody, kp.secretKey);

    const res = await req('POST', '/v1/relays/heartbeat', hbBody);
    expect(res.status).toBe(404);
  });

  it('rejects heartbeat with invalid signature', async () => {
    const kp = makeKeyPair();
    await req('POST', '/v1/relays/register', makeRegisterBody(kp));

    const hbBody: Record<string, unknown> = {
      relay_pubkey: kp.pubkey,
      models_supported: [],
      capacity: 1,
      fee_pct: 0.05,
      active_providers: 0,
      active_requests: 0,
      uptime_seconds: 0,
      timestamp: Date.now(),
      signature: 'ff'.repeat(64),
    };

    const res = await req('POST', '/v1/relays/heartbeat', hbBody);
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/relays', () => {
  it('returns ranked results', async () => {
    // Register 3 relays with different reputation scores
    const relays = [];
    for (let i = 0; i < 3; i++) {
      const kp = makeKeyPair();
      await req('POST', '/v1/relays/register', makeRegisterBody(kp, {
        endpoint: `wss://relay-${i}.example.com`,
        capacity: 10 + i,
      }));
      relays.push(kp);
    }

    // Manually set different reputation scores
    db.prepare('UPDATE relay_registry SET reputation_score = ? WHERE relay_pubkey = ?')
      .run(90, relays[2].pubkey);
    db.prepare('UPDATE relay_registry SET reputation_score = ? WHERE relay_pubkey = ?')
      .run(70, relays[1].pubkey);
    db.prepare('UPDATE relay_registry SET reputation_score = ? WHERE relay_pubkey = ?')
      .run(30, relays[0].pubkey);

    const res = await req('GET', '/v1/relays');
    const json = await res.json();

    expect(json.relays).toHaveLength(3);
    // Should be ordered by reputation descending
    expect(json.relays[0].reputation_score).toBe(90);
    expect(json.relays[1].reputation_score).toBe(70);
    expect(json.relays[2].reputation_score).toBe(30);
    expect(json.cache_ttl_seconds).toBe(60);
  });

  it('filters by region', async () => {
    const kpJP = makeKeyPair();
    const kpUS = makeKeyPair();
    await req('POST', '/v1/relays/register', makeRegisterBody(kpJP, {
      region: 'JP-Tokyo',
      endpoint: 'wss://jp.example.com',
    }));
    await req('POST', '/v1/relays/register', makeRegisterBody(kpUS, {
      region: 'US-Virginia',
      endpoint: 'wss://us.example.com',
    }));

    const res = await req('GET', '/v1/relays?region=JP');
    const json = await res.json();
    expect(json.relays).toHaveLength(1);
    expect(json.relays[0].region).toBe('JP-Tokyo');
  });

  it('filters by model', async () => {
    const kp1 = makeKeyPair();
    const kp2 = makeKeyPair();
    await req('POST', '/v1/relays/register', makeRegisterBody(kp1, {
      models_supported: ['claude-sonnet-4-20250514'],
      endpoint: 'wss://claude.example.com',
    }));
    await req('POST', '/v1/relays/register', makeRegisterBody(kp2, {
      models_supported: ['gpt-4o'],
      endpoint: 'wss://gpt.example.com',
    }));

    const res = await req('GET', '/v1/relays?model=gpt-4o');
    const json = await res.json();
    expect(json.relays).toHaveLength(1);
    expect(json.relays[0].models_supported).toContain('gpt-4o');
  });
});

describe('DELETE /v1/relays/:pubkey', () => {
  it('removes a registered relay', async () => {
    const kp = makeKeyPair();
    await req('POST', '/v1/relays/register', makeRegisterBody(kp));

    const delRes = await req('DELETE', `/v1/relays/${kp.pubkey}`);
    expect(delRes.status).toBe(200);

    const listRes = await req('GET', '/v1/relays');
    const list = await listRes.json();
    expect(list.relays).toHaveLength(0);
  });

  it('returns 404 for unknown pubkey', async () => {
    const res = await req('DELETE', '/v1/relays/deadbeef');
    expect(res.status).toBe(404);
  });
});

describe('Health check', () => {
  it('marks relays offline if no heartbeat for >90s', async () => {
    const kp = makeKeyPair();
    await req('POST', '/v1/relays/register', makeRegisterBody(kp));

    // Verify it's online
    let listRes = await req('GET', '/v1/relays');
    let list = await listRes.json();
    expect(list.relays).toHaveLength(1);

    // Simulate time passing: set last_heartbeat to 100s ago
    const oldTime = Date.now() - 100_000;
    db.prepare('UPDATE relay_registry SET last_heartbeat = ? WHERE relay_pubkey = ?')
      .run(oldTime, kp.pubkey);

    // Run health check
    runHealthCheck(db);

    // Should no longer appear in online list
    listRes = await req('GET', '/v1/relays');
    list = await listRes.json();
    expect(list.relays).toHaveLength(0);

    // Verify it's marked offline in DB
    const row = db.prepare('SELECT status FROM relay_registry WHERE relay_pubkey = ?')
      .get(kp.pubkey) as { status: string };
    expect(row.status).toBe('offline');
  });

  it('does not mark fresh relays as offline', async () => {
    const kp = makeKeyPair();
    await req('POST', '/v1/relays/register', makeRegisterBody(kp));

    runHealthCheck(db);

    const listRes = await req('GET', '/v1/relays');
    const list = await listRes.json();
    expect(list.relays).toHaveLength(1);
  });
});

describe('Prune', () => {
  it('removes relays offline for >24h', async () => {
    const kp = makeKeyPair();
    await req('POST', '/v1/relays/register', makeRegisterBody(kp));

    // Set offline with old heartbeat
    const veryOld = Date.now() - 25 * 3600_000;
    db.prepare(
      `UPDATE relay_registry SET status = 'offline', last_heartbeat = ? WHERE relay_pubkey = ?`,
    ).run(veryOld, kp.pubkey);

    pruneOfflineRelays(db);

    const row = db.prepare('SELECT * FROM relay_registry WHERE relay_pubkey = ?')
      .get(kp.pubkey);
    expect(row).toBeUndefined();
  });
});

describe('GET /health', () => {
  it('returns status and relay count', async () => {
    const res = await req('GET', '/health');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.relays_online).toBe(0);
  });
});
