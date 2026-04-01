import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRelay } from '../src/relay/index.js';
import { startProvider } from '../src/provider/index.js';
import { startGateway } from '../src/consumer/index.js';
import { createServer } from '../src/network/index.js';
import { initDatabase, checkpointAndClose } from '../src/db.js';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
} from '../src/crypto/index.js';
import WebSocket from 'ws';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

interface Wallet {
  signingPublicKey: Uint8Array;
  signingSecretKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
  encryptionSecretKey: Uint8Array;
}

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

describe('graceful shutdown', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'veil-shutdown-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // --- Relay Tests ---

  it('relay: idle shutdown completes within 1 second', async () => {
    const relay = await startRelay({
      port: 0,
      wallet: makeWallet(),
      dbPath: join(tempDir, 'relay.db'),
    });
    const start = Date.now();
    await relay.close();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('relay: WebSocket clients receive 1001 close frame', async () => {
    const port = 19200 + Math.floor(Math.random() * 100);
    const relay = await startRelay({
      port,
      wallet: makeWallet(),
      dbPath: join(tempDir, 'relay-ws.db'),
    });

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      ws.on('open', () => { relay.close(); });
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    const result = await closePromise;
    expect(result.code).toBe(1001);
    expect(result.reason).toBe('server shutting down');
  });

  it('relay: SQLite WAL is checkpointed on close', async () => {
    const dbPath = join(tempDir, 'relay-wal.db');
    const relay = await startRelay({
      port: 0,
      wallet: makeWallet(),
      dbPath,
    });
    await relay.close();
    const walPath = dbPath + '-wal';
    if (existsSync(walPath)) {
      expect(statSync(walPath).size).toBe(0);
    }
  });

  // --- Consumer Tests ---

  it('consumer: idle shutdown completes within 1 second', async () => {
    const relayPort = 19400 + Math.floor(Math.random() * 100);
    const relay = await startRelay({
      port: relayPort,
      wallet: makeWallet(),
      dbPath: join(tempDir, 'consumer-relay.db'),
    });
    const gateway = await startGateway({
      port: 19500 + Math.floor(Math.random() * 100),
      wallet: makeWallet(),
      relayUrl: `ws://localhost:${relayPort}`,
    });
    await new Promise((r) => setTimeout(r, 300));
    const start = Date.now();
    await gateway.close();
    expect(Date.now() - start).toBeLessThan(1000);
    await relay.close();
  });

  it('consumer: pending requests rejected on relay close', async () => {
    const relayPort = 19800 + Math.floor(Math.random() * 100);
    const relay = await startRelay({
      port: relayPort,
      wallet: makeWallet(),
      dbPath: join(tempDir, 'consumer-reject-relay.db'),
    });
    const gatewayPort = 19900 + Math.floor(Math.random() * 100);
    const gateway = await startGateway({
      port: gatewayPort,
      wallet: makeWallet(),
      relayUrl: `ws://localhost:${relayPort}`,
    });
    await new Promise((r) => setTimeout(r, 300));

    // Fire a request that will pend (no provider to answer)
    const reqPromise = fetch(`http://localhost:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer test' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });

    await new Promise((r) => setTimeout(r, 200));

    // Close the relay — should reject pending requests
    await relay.close();

    const start = Date.now();
    await gateway.close();
    expect(Date.now() - start).toBeLessThan(2000);

    const res = await reqPromise;
    expect([500, 502, 503]).toContain(res.status);
  });

  // --- Provider Tests ---

  it('provider: idle shutdown completes within 1 second', async () => {
    const relayPort = 19600 + Math.floor(Math.random() * 100);
    const relay = await startRelay({
      port: relayPort,
      wallet: makeWallet(),
      dbPath: join(tempDir, 'provider-relay.db'),
    });
    const provider = await startProvider({
      wallet: makeWallet(),
      relayUrl: `ws://localhost:${relayPort}`,
      apiKeys: [{ provider: 'anthropic', key: 'test-key' }],
      maxConcurrent: 5,
      healthPort: 0,
    });
    await new Promise((r) => setTimeout(r, 300));
    const start = Date.now();
    await provider.close();
    expect(Date.now() - start).toBeLessThan(1000);
    await relay.close();
  });

  // --- Network Layer Tests ---

  it('network: server closeAll sends 1001 to all clients', async () => {
    const serverPort = 19700 + Math.floor(Math.random() * 100);
    const server = createServer({
      port: serverPort,
      onConnection() {},
    });
    const results: Array<{ code: number; reason: string }> = [];
    const done = new Promise<void>((resolve) => {
      let count = 0;
      for (let i = 0; i < 2; i++) {
        const ws = new WebSocket(`ws://localhost:${serverPort}`);
        ws.on('close', (code, reason) => {
          results.push({ code, reason: reason.toString() });
          count++;
          if (count === 2) resolve();
        });
      }
    });
    await new Promise((r) => setTimeout(r, 200));
    server.closeAll();
    await done;
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.code).toBe(1001);
      expect(r.reason).toBe('server shutting down');
    }
  });

  // --- Database Tests ---

  it('db: checkpointAndClose flushes WAL', () => {
    const dbPath = join(tempDir, 'checkpoint-test.db');
    const db = initDatabase(dbPath);
    db.prepare('INSERT INTO usage_log (request_id, direction, model, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
      'test-1', 'outbound', 'test-model', 'ok', Date.now(),
    );
    checkpointAndClose(db);
    const walPath = dbPath + '-wal';
    if (existsSync(walPath)) {
      expect(statSync(walPath).size).toBe(0);
    }
  });
});
