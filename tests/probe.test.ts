import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRelay } from '../src/relay/index.js';
import { connect } from '../src/network/index.js';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  sign,
  sha256,
  toHex,
} from '../src/crypto/index.js';
import type { WsMessage } from '../src/types.js';

const PROBE_OPT = { probeSilenceMs: 200, probeTimeoutMs: 150, probeIntervalMs: 50 };

function makeWallet() {
  const signing = generateSigningKeyPair();
  const enc = generateEncryptionKeyPair();
  return {
    signingPublicKey: signing.publicKey,
    signingSecretKey: signing.secretKey,
    encryptionPublicKey: enc.publicKey,
    encryptionSecretKey: enc.secretKey,
  };
}

function buildHello(w: ReturnType<typeof makeWallet>): WsMessage {
  const p = {
    provider_pubkey: toHex(w.signingPublicKey),
    encryption_pubkey: toHex(w.encryptionPublicKey),
    models: ['claude-sonnet-4-20250514'],
    capacity: 10,
  };
  const ts = Date.now();
  const sig = sign(new TextEncoder().encode(JSON.stringify({ ...p, timestamp: ts })), w.signingSecretKey);
  return { type: 'provider_hello', payload: { ...p, signature: toHex(sig) }, timestamp: ts };
}

function buildRequest(
  consumer: ReturnType<typeof makeWallet>,
  provider: ReturnType<typeof makeWallet>,
  requestId: string,
): WsMessage {
  const inner = Buffer.from('fake-inner').toString('base64');
  const innerHash = toHex(sha256(new Uint8Array(Buffer.from(inner, 'base64'))));
  const ts = Date.now();
  const signable = JSON.stringify({
    request_id: requestId,
    consumer_pubkey: toHex(consumer.signingPublicKey),
    provider_id: toHex(provider.signingPublicKey),
    model: 'claude-sonnet-4-20250514',
    timestamp: ts,
    inner_hash: innerHash,
  });
  const sig = sign(new TextEncoder().encode(signable), consumer.signingSecretKey);
  return {
    type: 'request',
    request_id: requestId,
    payload: {
      outer: {
        consumer_pubkey: toHex(consumer.signingPublicKey),
        provider_id: toHex(provider.signingPublicKey),
        model: 'claude-sonnet-4-20250514',
        signature: toHex(sig),
      },
      inner,
    },
    timestamp: ts,
  };
}

describe('probe', () => {
  let tempDir = '';
  let relay: { close(): Promise<void> } | null = null;
  const closables: Array<{ close(): void }> = [];

  afterEach(async () => {
    closables.forEach((c) => c.close());
    closables.length = 0;
    if (relay) { await relay.close(); relay = null; }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('probe acknowledged — request completes normally', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'veil-probe-test-'));
    const port = 20601 + Math.floor(Math.random() * 50);
    const relayWallet = makeWallet();
    relay = await startRelay({
      port,
      wallet: relayWallet,
      dbPath: join(tempDir, 'relay.db'),
      ...PROBE_OPT,
    });

    const providerWallet = makeWallet();
    const consumerWallet = makeWallet();
    const consumerMessages: WsMessage[] = [];
    const requestId = 'probe-ack-001';

    const providerConn = await connect({
      url: `ws://localhost:${port}`,
      onMessage(msg) {
        if (msg.type === 'probe') {
          providerConn.send({
            type: 'probe_ack',
            request_id: msg.request_id,
            payload: { status: 'alive' },
            timestamp: Date.now(),
          });
          setTimeout(() => {
            providerConn.send({
              type: 'response',
              request_id: requestId,
              payload: { encrypted_body: 'ok' },
              timestamp: Date.now(),
            });
          }, 50);
        }
      },
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
    });
    closables.push(providerConn);
    providerConn.send(buildHello(providerWallet));
    await new Promise((r) => setTimeout(r, 200));

    const consumerConn = await connect({
      url: `ws://localhost:${port}`,
      onMessage(msg) { consumerMessages.push(msg); },
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
    });
    closables.push(consumerConn);
    consumerConn.send(buildRequest(consumerWallet, providerWallet, requestId));

    await new Promise((r) => setTimeout(r, 700));

    const response = consumerMessages.find((m) => m.type === 'response');
    const dead = consumerMessages.find((m) => m.type === 'error' && (m.payload as { code?: string })?.code === 'provider_dead');
    expect(response).toBeDefined();
    expect(dead).toBeUndefined();
  });

  it('two consecutive probe timeouts — provider declared dead', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'veil-probe-test-'));
    const port = 20651 + Math.floor(Math.random() * 50);
    const relayWallet = makeWallet();
    relay = await startRelay({
      port,
      wallet: relayWallet,
      dbPath: join(tempDir, 'relay.db'),
      ...PROBE_OPT,
    });

    const providerWallet = makeWallet();
    const consumerWallet = makeWallet();
    const consumerMessages: WsMessage[] = [];
    const requestId = 'probe-dead-001';

    const providerConn = await connect({
      url: `ws://localhost:${port}`,
      onMessage() { /* silent — ignores everything including probes */ },
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
    });
    closables.push(providerConn);
    providerConn.send(buildHello(providerWallet));
    await new Promise((r) => setTimeout(r, 200));

    const consumerConn = await connect({
      url: `ws://localhost:${port}`,
      onMessage(msg) { consumerMessages.push(msg); },
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
    });
    closables.push(consumerConn);
    consumerConn.send(buildRequest(consumerWallet, providerWallet, requestId));

    // Allow time for 2 full probe cycles:
    // ~200ms silence → probe1 → ~150ms timeout → probe2 → ~150ms timeout → dead
    await new Promise((r) => setTimeout(r, 900));

    const dead = consumerMessages.find(
      (m) => m.type === 'error' && (m.payload as { code?: string })?.code === 'provider_dead',
    );
    expect(dead).toBeDefined();
    expect(dead!.request_id).toBe(requestId);
  });

  it('one probe failure then ack resets count — request completes', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'veil-probe-test-'));
    const port = 20701 + Math.floor(Math.random() * 50);
    const relayWallet = makeWallet();
    relay = await startRelay({
      port,
      wallet: relayWallet,
      dbPath: join(tempDir, 'relay.db'),
      ...PROBE_OPT,
    });

    const providerWallet = makeWallet();
    const consumerWallet = makeWallet();
    const consumerMessages: WsMessage[] = [];
    const requestId = 'probe-reset-001';

    let probeCount = 0;
    const providerConn = await connect({
      url: `ws://localhost:${port}`,
      onMessage(msg) {
        if (msg.type === 'probe') {
          probeCount++;
          if (probeCount === 1) return; // ignore first probe → failure #1
          // Ack second probe → failures reset to 0
          providerConn.send({
            type: 'probe_ack',
            request_id: msg.request_id,
            payload: { status: 'alive' },
            timestamp: Date.now(),
          });
          setTimeout(() => {
            providerConn.send({
              type: 'response',
              request_id: requestId,
              payload: { encrypted_body: 'ok' },
              timestamp: Date.now(),
            });
          }, 50);
        }
      },
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
    });
    closables.push(providerConn);
    providerConn.send(buildHello(providerWallet));
    await new Promise((r) => setTimeout(r, 200));

    const consumerConn = await connect({
      url: `ws://localhost:${port}`,
      onMessage(msg) { consumerMessages.push(msg); },
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
    });
    closables.push(consumerConn);
    consumerConn.send(buildRequest(consumerWallet, providerWallet, requestId));

    // probe1 ~200ms, timeout at ~350ms, probe2 ~400ms, ack at ~400ms, response at ~450ms
    await new Promise((r) => setTimeout(r, 900));

    const response = consumerMessages.find((m) => m.type === 'response');
    const dead = consumerMessages.find(
      (m) => m.type === 'error' && (m.payload as { code?: string })?.code === 'provider_dead',
    );
    expect(response).toBeDefined();
    expect(dead).toBeUndefined();
  });
});
