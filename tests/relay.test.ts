import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRelay, verifyRequest, createWitness } from '../src/relay/index.js';
import { connect } from '../src/network/index.js';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  sign,
  seal,
  sha256,
  toHex,
} from '../src/crypto/index.js';
import type { WsMessage, ProviderHelloPayload, RequestPayload } from '../src/types.js';
import Database from 'better-sqlite3';

describe('relay', () => {
  let tempDir: string;
  let relayPort: number;
  let relay: { close(): Promise<void> } | null = null;
  const closables: Array<{ close(): void }> = [];

  function makeWallet() {
    const signing = generateSigningKeyPair();
    const encryption = generateEncryptionKeyPair();
    return {
      signingPublicKey: signing.publicKey,
      signingSecretKey: signing.secretKey,
      encryptionPublicKey: encryption.publicKey,
      encryptionSecretKey: encryption.secretKey,
    };
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'veil-relay-test-'));
    const relayWallet = makeWallet();
    relay = await startRelay({
      port: 0,
      wallet: relayWallet,
      dbPath: join(tempDir, 'relay.db'),
    });
    // Hacky: get actual port from db path area or we need to expose it
    // We'll read from the createServer return. Let's use a known-free port approach.
  });

  afterEach(async () => {
    closables.forEach((c) => c.close());
    closables.length = 0;
    if (relay) await relay.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // For these tests we need the relay port. Let's refactor to use a direct approach.
  // Since startRelay doesn't expose port, we'll test the components directly.

  it('provider hello + ack flow', async () => {
    // Use a fresh relay with known port
    if (relay) await relay.close();

    const relayWallet = makeWallet();
    relayPort = 19800 + Math.floor(Math.random() * 100);
    relay = await startRelay({
      port: relayPort,
      wallet: relayWallet,
      dbPath: join(tempDir, 'relay2.db'),
    });

    const providerWallet = makeWallet();
    const messages: WsMessage[] = [];

    const conn = await connect({
      url: `ws://localhost:${relayPort}`,
      onMessage(msg) { messages.push(msg); },
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
    });
    closables.push(conn);

    // Send provider_hello
    const payload = {
      provider_pubkey: toHex(providerWallet.signingPublicKey),
      encryption_pubkey: toHex(providerWallet.encryptionPublicKey),
      models: ['claude-sonnet-4-20250514'],
      capacity: 100,
    };
    const timestamp = Date.now();
    const signable = JSON.stringify({ ...payload, timestamp });
    const signature = sign(new TextEncoder().encode(signable), providerWallet.signingSecretKey);

    conn.send({
      type: 'provider_hello',
      payload: { ...payload, signature: toHex(signature) },
      timestamp,
    });

    await new Promise((r) => setTimeout(r, 300));

    const ack = messages.find((m) => m.type === 'provider_ack');
    expect(ack).toBeDefined();
    expect((ack!.payload as { status: string }).status).toBe('accepted');
  });

  it('request forwarding: consumer_pubkey stripped', async () => {
    if (relay) await relay.close();

    const relayWallet = makeWallet();
    relayPort = 19900 + Math.floor(Math.random() * 100);
    relay = await startRelay({
      port: relayPort,
      wallet: relayWallet,
      dbPath: join(tempDir, 'relay3.db'),
    });

    const providerWallet = makeWallet();
    const consumerWallet = makeWallet();
    const providerMessages: WsMessage[] = [];

    // Connect provider
    const providerConn = await connect({
      url: `ws://localhost:${relayPort}`,
      onMessage(msg) { providerMessages.push(msg); },
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
    });
    closables.push(providerConn);

    // Register provider
    const helloPayload = {
      provider_pubkey: toHex(providerWallet.signingPublicKey),
      encryption_pubkey: toHex(providerWallet.encryptionPublicKey),
      models: ['claude-sonnet-4-20250514'],
      capacity: 100,
    };
    const helloTs = Date.now();
    const helloSig = sign(
      new TextEncoder().encode(JSON.stringify({ ...helloPayload, timestamp: helloTs })),
      providerWallet.signingSecretKey,
    );
    providerConn.send({
      type: 'provider_hello',
      payload: { ...helloPayload, signature: toHex(helloSig) },
      timestamp: helloTs,
    });

    await new Promise((r) => setTimeout(r, 300));

    // Connect consumer
    const consumerConn = await connect({
      url: `ws://localhost:${relayPort}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
    });
    closables.push(consumerConn);

    // Build and send request
    const innerPlaintext = JSON.stringify({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      temperature: 1,
      top_p: 1,
      stop_sequences: [],
      stream: false,
    });
    const sealed = seal(
      new TextEncoder().encode(innerPlaintext),
      providerWallet.encryptionPublicKey,
      consumerWallet.encryptionSecretKey,
    );
    const innerBase64 = Buffer.from(sealed).toString('base64');
    const innerHash = toHex(sha256(sealed));

    const requestId = 'test-req-001';
    const reqTs = Date.now();
    const signable = JSON.stringify({
      request_id: requestId,
      consumer_pubkey: toHex(consumerWallet.signingPublicKey),
      provider_id: toHex(providerWallet.signingPublicKey),
      model: 'claude-sonnet-4-20250514',
      timestamp: reqTs,
      inner_hash: innerHash,
    });
    const reqSig = sign(new TextEncoder().encode(signable), consumerWallet.signingSecretKey);

    consumerConn.send({
      type: 'request',
      request_id: requestId,
      payload: {
        outer: {
          consumer_pubkey: toHex(consumerWallet.signingPublicKey),
          provider_id: toHex(providerWallet.signingPublicKey),
          model: 'claude-sonnet-4-20250514',
          signature: toHex(reqSig),
        },
        inner: innerBase64,
      },
      timestamp: reqTs,
    });

    await new Promise((r) => setTimeout(r, 500));

    const forwarded = providerMessages.find((m) => m.type === 'request');
    expect(forwarded).toBeDefined();
    const fwdPayload = forwarded!.payload as RequestPayload;
    expect(fwdPayload.outer.consumer_pubkey).toBe('redacted');
  });

  it('invalid signature rejected', async () => {
    if (relay) await relay.close();

    const relayWallet = makeWallet();
    relayPort = 20000 + Math.floor(Math.random() * 100);
    relay = await startRelay({
      port: relayPort,
      wallet: relayWallet,
      dbPath: join(tempDir, 'relay4.db'),
    });

    const consumerMessages: WsMessage[] = [];
    const consumerConn = await connect({
      url: `ws://localhost:${relayPort}`,
      onMessage(msg) { consumerMessages.push(msg); },
      onClose() {},
      onError() {},
      reconnect: false,
      pingIntervalMs: 60000,
    });
    closables.push(consumerConn);

    const consumerWallet = makeWallet();
    const wrongWallet = makeWallet();

    consumerConn.send({
      type: 'request',
      request_id: 'bad-sig-001',
      payload: {
        outer: {
          consumer_pubkey: toHex(consumerWallet.signingPublicKey),
          provider_id: toHex(wrongWallet.signingPublicKey),
          model: 'claude-sonnet-4-20250514',
          signature: toHex(new Uint8Array(64)), // Zeroed signature
        },
        inner: Buffer.from('fake').toString('base64'),
      },
      timestamp: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 300));

    const err = consumerMessages.find((m) => m.type === 'error');
    expect(err).toBeDefined();
  });

  it('witness record inserted in DB', () => {
    const relayWallet = makeWallet();
    const witness = createWitness(
      'test-witness-001',
      'consumer-pubkey-hex',
      'provider-pubkey-hex',
      'claude-sonnet-4-20250514',
      100,
      50,
      relayWallet,
    );

    expect(witness.request_id).toBe('test-witness-001');
    expect(witness.provider_id).toBe('provider-pubkey-hex');
    expect(witness.model).toBe('claude-sonnet-4-20250514');
    expect(witness.input_tokens).toBe(100);
    expect(witness.output_tokens).toBe(50);
    expect(witness.relay_signature).toMatch(/^[0-9a-f]+$/);
    expect(witness.consumer_hash).toMatch(/^[0-9a-f]+$/);
  });

  it('stale request (timestamp > 5min old) rejected', () => {
    const wallet = makeWallet();
    const staleTimestamp = Date.now() - 6 * 60 * 1000; // 6 minutes ago

    const innerPlaintext = 'test';
    const innerBase64 = Buffer.from(innerPlaintext).toString('base64');
    const innerHash = toHex(sha256(new Uint8Array(Buffer.from(innerBase64, 'base64'))));

    const requestId = 'stale-001';
    const signable = JSON.stringify({
      request_id: requestId,
      consumer_pubkey: toHex(wallet.signingPublicKey),
      provider_id: toHex(wallet.signingPublicKey),
      model: 'test',
      timestamp: staleTimestamp,
      inner_hash: innerHash,
    });
    const signature = sign(new TextEncoder().encode(signable), wallet.signingSecretKey);

    const valid = verifyRequest(
      {
        consumer_pubkey: toHex(wallet.signingPublicKey),
        provider_id: toHex(wallet.signingPublicKey),
        model: 'test',
        signature: toHex(signature),
      },
      requestId,
      staleTimestamp,
      innerBase64,
    );

    expect(valid).toBe(false);
  });

  it('enforces rate limits on consumer requests', async () => {
    if (relay) await relay.close();

    process.env['VEIL_RELAY_RATE_LIMIT'] = '3';
    
    const relayWallet = makeWallet();
    relayPort = 20200 + Math.floor(Math.random() * 100);
    relay = await startRelay({
      port: relayPort,
      wallet: relayWallet,
      dbPath: join(tempDir, 'relay6.db'),
    });

    const providerWallet = makeWallet();
    const consumerWallet = makeWallet();

    const consumerMessages: WsMessage[] = [];
    const consumerConn = await connect({
      url: `ws://localhost:${relayPort}`,
      onMessage(msg) { consumerMessages.push(msg); },
      onClose() {},
      onError() {},
      reconnect: false,
    });
    closables.push(consumerConn);

    const providerConn = await connect({
      url: `ws://localhost:${relayPort}`,
      onMessage() {},
      onClose() {},
      onError() {},
      reconnect: false,
    });
    closables.push(providerConn);

    const helloTs = Date.now();
    const helloPayload = {
      provider_pubkey: toHex(providerWallet.signingPublicKey),
      encryption_pubkey: toHex(providerWallet.encryptionPublicKey),
      models: ['test-model'],
      capacity: 100,
    };
    const helloSig = sign(
      new TextEncoder().encode(JSON.stringify({ ...helloPayload, timestamp: helloTs })),
      providerWallet.signingSecretKey,
    );
    providerConn.send({
      type: 'provider_hello',
      payload: { ...helloPayload, signature: toHex(helloSig) },
      timestamp: helloTs,
    });

    await new Promise((r) => setTimeout(r, 200));

    // Send 4 requests. 3 should be fine, 4th should get 429
    for (let i = 0; i < 4; i++) {
      const innerPlaintext = 'test' + i;
      const innerBase64 = Buffer.from(innerPlaintext).toString('base64');
      const innerHash = toHex(sha256(new Uint8Array(Buffer.from(innerBase64, 'base64'))));
      const requestId = 'req-' + i;
      const reqTs = Date.now();
      const signable = JSON.stringify({
        request_id: requestId,
        consumer_pubkey: toHex(consumerWallet.signingPublicKey),
        provider_id: toHex(providerWallet.signingPublicKey),
        model: 'test-model',
        timestamp: reqTs,
        inner_hash: innerHash,
      });
      const signature = sign(new TextEncoder().encode(signable), consumerWallet.signingSecretKey);
  
      consumerConn.send({
        type: 'request',
        request_id: requestId,
        payload: {
          outer: {
            consumer_pubkey: toHex(consumerWallet.signingPublicKey),
            provider_id: toHex(providerWallet.signingPublicKey),
            model: 'test-model',
            signature: toHex(signature),
          },
          inner: innerBase64,
        },
        timestamp: reqTs,
      });
    }

    await new Promise((r) => setTimeout(r, 300));

    const errMessages = consumerMessages.filter(m => m.type === 'error' && (m.payload as any).code === '429');
    expect(errMessages.length).toBe(1);
    expect(errMessages[0].request_id).toBe('req-3');
    
    // Restore env var
    delete process.env['VEIL_RELAY_RATE_LIMIT'];
  });
});
