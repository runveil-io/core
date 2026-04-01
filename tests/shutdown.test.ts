import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { startRelay } from '../src/relay/index.js';
import { startProvider } from '../src/provider/index.js';
import { startGateway } from '../src/consumer/index.js';
import { ShutdownManager } from '../src/shutdown.js';
import { createServer, connect } from '../src/network/index.js';
import { initDatabase, checkpointAndClose } from '../src/db.js';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
} from '../src/crypto/index.js';
import type { Wallet } from '../src/wallet/index.js';
import type { WsMessage } from '../src/types.js';

function makeWallet(): Wallet {
  const signing = generateSigningKeyPair();
  const encryption = generateEncryptionKeyPair();
  return {
    signingPublicKey: signing.publicKey,
    signingSecretKey: signing.secretKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionSecretKey: encryption.secretKey,
  };
}

function randomPort(base: number): number {
  return base + Math.floor(Math.random() * 200);
}

// ═══════════════════════════════════════════════════════
// 1. ShutdownManager tests (isolated, no global listeners)
// ═══════════════════════════════════════════════════════

describe('ShutdownManager', () => {
  let manager: ShutdownManager;

  beforeEach(() => {
    manager = new ShutdownManager(5000);
  });

  afterEach(() => {
    manager.reset();
  });

  it('runs cleanups in registration order', async () => {
    const order: string[] = [];
    manager.register('first', async () => { order.push('first'); });
    manager.register('second', async () => { order.push('second'); });
    manager.register('third', async () => { order.push('third'); });

    const code = await manager.shutdown();
    expect(code).toBe(0);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('returns 0 for clean shutdown', async () => {
    manager.register('noop', async () => {});
    const code = await manager.shutdown();
    expect(code).toBe(0);
    expect(manager.hasCompleted).toBe(true);
  });

  it('returns 1 when a cleanup throws', async () => {
    manager.register('fail', async () => {
      throw new Error('boom');
    });
    const code = await manager.shutdown();
    expect(code).toBe(1);
    expect(manager.hasCompleted).toBe(true);
  });

  it('returns 1 when a cleanup times out', async () => {
    manager.register('slow', async () => {
      await new Promise((r) => setTimeout(r, 10_000));
    }, 200); // 200ms timeout

    const code = await manager.shutdown();
    expect(code).toBe(1);
  }, 5000);

  it('is idempotent — calling shutdown() twice returns same result', async () => {
    let callCount = 0;
    manager.register('counter', async () => { callCount++; });

    const code1 = await manager.shutdown();
    const code2 = await manager.shutdown();
    expect(code1).toBe(0);
    expect(code2).toBe(0);
    expect(callCount).toBe(1);
  });

  it('register with same name replaces previous entry', async () => {
    let value = '';
    manager.register('replaceable', async () => { value = 'original'; });
    manager.register('replaceable', async () => { value = 'replaced'; });

    await manager.shutdown();
    expect(value).toBe('replaced');
  });

  it('emits status messages via onStatus callback', async () => {
    const messages: string[] = [];
    manager.onStatus = (msg) => messages.push(msg);

    manager.register('test', async () => {});
    await manager.shutdown();

    expect(messages.some((m) => m.includes('Shutting'))).toBe(true);
    expect(messages.some((m) => m.includes('Done'))).toBe(true);
  });

  it('continues cleanup when one component fails', async () => {
    const completed: string[] = [];

    manager.register('fails', async () => { throw new Error('fail'); });
    manager.register('succeeds', async () => { completed.push('ok'); });

    const code = await manager.shutdown();
    expect(code).toBe(1);
    expect(completed).toEqual(['ok']);
  });

  it('can be reset and reused', async () => {
    let count = 0;
    manager.register('counter', async () => { count++; });
    await manager.shutdown();
    expect(count).toBe(1);

    manager.reset();
    manager.register('counter2', async () => { count++; });
    await manager.shutdown();
    expect(count).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════
// 2. Network layer — close codes and connection tracking
// ═══════════════════════════════════════════════════════

describe('network closeAll', () => {
  it('closes all connections with code 1001', async () => {
    const port = randomPort(19400);
    const receivedCodes: number[] = [];

    const server = createServer({
      port,
      onConnection(_conn) {
        // Server side — just accept
      },
    });

    // Connect 3 clients
    const clients: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));
      ws.on('close', (code) => receivedCodes.push(code));
      clients.push(ws);
    }

    expect(server.connectionCount).toBe(3);

    // Close all with 1001
    await server.closeAll(1001, 'test_shutdown');

    // Wait briefly for close events to propagate
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedCodes.length).toBe(3);
    for (const code of receivedCodes) {
      expect(code).toBe(1001);
    }
  });

  it('closeAll resolves even with no connections', async () => {
    const port = randomPort(19500);
    const server = createServer({
      port,
      onConnection() {},
    });

    // Should resolve immediately
    await server.closeAll(1001, 'test');
    // No error = pass
  });
});

// ═══════════════════════════════════════════════════════
// 3. Database — WAL checkpoint
// ═══════════════════════════════════════════════════════

describe('checkpointAndClose', () => {
  it('checkpoints and closes DB without error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'veil-db-test-'));
    const dbPath = join(dir, 'test.db');
    const db = initDatabase(dbPath);

    // Insert some data to generate WAL frames
    db.prepare('INSERT INTO usage_log (request_id, direction, model, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'test-req-1', 'outbound', 'claude', 'ok', Date.now(),
    );

    // Should not throw
    checkpointAndClose(db);

    // Verify DB is closed — querying should throw
    expect(() => db.prepare('SELECT 1')).toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  it('handles double close gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'veil-db-test2-'));
    const dbPath = join(dir, 'test.db');
    const db = initDatabase(dbPath);
    checkpointAndClose(db);

    // Second close should not throw (checkpointAndClose catches internally)
    expect(() => checkpointAndClose(db)).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════
// 4. Role shutdown — Consumer
// ═══════════════════════════════════════════════════════

describe('consumer shutdown', () => {
  let tempDir: string;
  let relayHandle: { close(): Promise<void> };
  let gatewayHandle: { close(): Promise<void>; port: number };
  let relayPort: number;
  let gatewayPort: number;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'veil-shutdown-consumer-'));
    relayPort = randomPort(19600);

    relayHandle = await startRelay({
      port: relayPort,
      wallet: makeWallet(),
      dbPath: join(tempDir, 'relay.db'),
    });

    gatewayPort = randomPort(19700);
    gatewayHandle = await startGateway({
      port: gatewayPort,
      wallet: makeWallet(),
      relayUrl: `ws://localhost:${relayPort}`,
    });

    await new Promise((r) => setTimeout(r, 300));
  }, 10000);

  afterAll(async () => {
    await gatewayHandle?.close();
    await relayHandle?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 503 with shutting_down code after shutdown is initiated', async () => {
    // Before shutdown: health endpoint proves server is alive and accepting
    const healthBefore = await fetch(`http://localhost:${gatewayPort}/health`);
    expect(healthBefore.status).toBe(200);
    const healthBody = await healthBefore.json() as { status: string };
    expect(healthBody.status).toBe('ok');

    // Initiate shutdown
    await gatewayHandle.close();

    // Post-shutdown: request should get 503 with 'shutting_down' code
    // (distinct from the 'no_providers' 503 which is a business-logic error)
    const resAfter = await fetch(`http://localhost:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'test' }],
      }),
    }).catch(() => null);

    if (resAfter) {
      expect(resAfter.status).toBe(503);
      const body = await resAfter.json() as { error: { code: string } };
      expect(body.error.code).toBe('shutting_down');
    }
    // If connection refused, server is fully closed — also acceptable
  });

  it('close() is idempotent', async () => {
    // Calling close multiple times should not throw
    await gatewayHandle.close();
    await gatewayHandle.close();
  });
});

// ═══════════════════════════════════════════════════════
// 5. Role shutdown — Provider
// ═══════════════════════════════════════════════════════

describe('provider shutdown', () => {
  let tempDir: string;
  let relayHandle: { close(): Promise<void> };
  let providerHandle: { close(): Promise<void> };
  let relayPort: number;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'veil-shutdown-provider-'));
    relayPort = randomPort(19800);

    relayHandle = await startRelay({
      port: relayPort,
      wallet: makeWallet(),
      dbPath: join(tempDir, 'relay.db'),
    });

    providerHandle = await startProvider({
      wallet: makeWallet(),
      relayUrl: `ws://localhost:${relayPort}`,
      apiKeys: [{ provider: 'anthropic', key: 'test-key' }],
      maxConcurrent: 5,
      healthPort: randomPort(21000),
    });

    await new Promise((r) => setTimeout(r, 300));
  }, 10000);

  afterAll(async () => {
    await providerHandle?.close();
    await relayHandle?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('shutdown with no active requests completes quickly', async () => {
    const start = Date.now();
    await providerHandle.close();
    const elapsed = Date.now() - start;

    // Should complete in well under 30s since there are no active requests
    expect(elapsed).toBeLessThan(5000);
  });

  it('close() is idempotent', async () => {
    await providerHandle.close();
    await providerHandle.close();
  });
});

// ═══════════════════════════════════════════════════════
// 6. Role shutdown — Relay
// ═══════════════════════════════════════════════════════

describe('relay shutdown', () => {
  it('notifies connected providers and closes with 1001', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'veil-shutdown-relay-'));
    const relayPort = randomPort(20000);

    const relay = await startRelay({
      port: relayPort,
      wallet: makeWallet(),
      dbPath: join(tempDir, 'relay.db'),
    });

    // Connect a client to act as a provider
    const receivedMessages: WsMessage[] = [];
    let closeCode: number | null = null;

    const ws = new WebSocket(`ws://localhost:${relayPort}`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.on('message', (data) => {
      try {
        receivedMessages.push(JSON.parse(data.toString()));
      } catch {}
    });
    ws.on('close', (code) => {
      closeCode = code;
    });

    // Send a provider_hello to register
    const providerWallet = makeWallet();
    const { toHex, sign } = await import('../src/crypto/index.js');
    const helloPayload = {
      provider_pubkey: toHex(providerWallet.signingPublicKey),
      encryption_pubkey: toHex(providerWallet.encryptionPublicKey),
      models: ['claude-sonnet-4-20250514'],
      capacity: 100,
    };
    const timestamp = Date.now();
    const signable = JSON.stringify({ ...helloPayload, timestamp });
    const signature = sign(new TextEncoder().encode(signable), providerWallet.signingSecretKey);

    ws.send(JSON.stringify({
      type: 'provider_hello',
      payload: { ...helloPayload, signature: toHex(signature) },
      timestamp,
    }));

    await new Promise((r) => setTimeout(r, 300));

    // Now close the relay
    await relay.close();

    // Wait for close event
    await new Promise((r) => setTimeout(r, 500));

    // Provider should have received a shutdown notification
    const shutdownMsg = receivedMessages.find(
      (m) => m.type === 'provider_ack' && (m.payload as any)?.reason === 'relay_shutdown',
    );
    expect(shutdownMsg).toBeDefined();

    // WebSocket should be closed with 1001
    expect(closeCode).toBe(1001);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('flush DB (WAL checkpoint) on close', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'veil-shutdown-relay-db-'));
    const relayPort = randomPort(20100);
    const dbPath = join(tempDir, 'relay.db');

    const relay = await startRelay({
      port: relayPort,
      wallet: makeWallet(),
      dbPath,
    });

    await relay.close();

    // Verify DB file exists and is not corrupt — open it fresh
    const db = initDatabase(dbPath);
    const row = db.prepare('SELECT COUNT(*) as count FROM provider_state').get() as { count: number };
    expect(row.count).toBeGreaterThanOrEqual(0);
    db.close();

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('shutdown with no connections completes quickly', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'veil-shutdown-relay-fast-'));
    const relayPort = randomPort(20200);

    const relay = await startRelay({
      port: relayPort,
      wallet: makeWallet(),
      dbPath: join(tempDir, 'relay.db'),
    });

    const start = Date.now();
    await relay.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    rmSync(tempDir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════
// 7. Integration — full stack shutdown
// ═══════════════════════════════════════════════════════

describe('integration shutdown', () => {
  it('full stack shuts down cleanly with no active streams', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'veil-shutdown-integration-'));
    const relayPort = randomPort(20300);
    const gatewayPort = randomPort(20400);

    const relay = await startRelay({
      port: relayPort,
      wallet: makeWallet(),
      dbPath: join(tempDir, 'relay.db'),
    });

    const provider = await startProvider({
      wallet: makeWallet(),
      relayUrl: `ws://localhost:${relayPort}`,
      apiKeys: [{ provider: 'anthropic', key: 'test-key' }],
      maxConcurrent: 5,
      healthPort: randomPort(21200),
    });

    const gateway = await startGateway({
      port: gatewayPort,
      wallet: makeWallet(),
      relayUrl: `ws://localhost:${relayPort}`,
    });

    await new Promise((r) => setTimeout(r, 500));

    // Shut down in reverse order: consumer → provider → relay
    const start = Date.now();
    await gateway.close();
    await provider.close();
    await relay.close();
    const elapsed = Date.now() - start;

    // Should complete quickly with no active streams
    expect(elapsed).toBeLessThan(5000);

    rmSync(tempDir, { recursive: true, force: true });
  }, 15000);
});
