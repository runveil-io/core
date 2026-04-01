import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WitnessStore, type WitnessRecord } from '../src/relay/witness.js';
import {
  generateSigningKeyPair,
  toHex,
} from '../src/crypto/index.js';

describe('WitnessStore', () => {
  let tempDir: string;
  let store: WitnessStore;
  let relayKeys: { publicKey: Uint8Array; secretKey: Uint8Array };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'veil-witness-test-'));
    store = new WitnessStore(join(tempDir, 'witness.db'));
    relayKeys = generateSigningKeyPair();
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeParams(overrides?: Partial<Omit<WitnessRecord, 'relay_signature'>>): Omit<WitnessRecord, 'relay_signature'> {
    return {
      request_id: `req-${Math.random().toString(36).slice(2)}`,
      consumer_pubkey: toHex(generateSigningKeyPair().publicKey),
      provider_pubkey: toHex(generateSigningKeyPair().publicKey),
      model: 'claude-sonnet-4-20250514',
      input_tokens: 100,
      output_tokens: 50,
      duration_ms: 1200,
      timestamp: Date.now(),
      relay_pubkey: toHex(relayKeys.publicKey),
      ...overrides,
    };
  }

  // ---- Record creation ----

  it('should record a witness with valid signature', () => {
    const params = makeParams();
    const record = store.record(params, relayKeys.secretKey);

    expect(record.request_id).toBe(params.request_id);
    expect(record.relay_signature).toBeTruthy();
    expect(record.relay_signature.length).toBe(128); // 64 bytes hex
    expect(record.input_tokens).toBe(100);
    expect(record.output_tokens).toBe(50);
  });

  it('should record with cache tokens', () => {
    const params = makeParams({
      cache_read_tokens: 25,
      cache_write_tokens: 10,
    });
    const record = store.record(params, relayKeys.secretKey);

    expect(record.cache_read_tokens).toBe(25);
    expect(record.cache_write_tokens).toBe(10);
  });

  it('should reject duplicate request_id', () => {
    const params = makeParams();
    store.record(params, relayKeys.secretKey);

    expect(() => store.record(params, relayKeys.secretKey)).toThrow();
  });

  // ---- Signature verification ----

  it('should verify a valid signature', () => {
    const params = makeParams();
    const record = store.record(params, relayKeys.secretKey);

    expect(store.verify(record, relayKeys.publicKey)).toBe(true);
  });

  it('should reject a tampered record', () => {
    const params = makeParams();
    const record = store.record(params, relayKeys.secretKey);

    // Tamper with token count
    const tampered = { ...record, output_tokens: 9999 };
    expect(store.verify(tampered, relayKeys.publicKey)).toBe(false);
  });

  it('should reject wrong public key', () => {
    const params = makeParams();
    const record = store.record(params, relayKeys.secretKey);

    const otherKeys = generateSigningKeyPair();
    expect(store.verify(record, otherKeys.publicKey)).toBe(false);
  });

  it('should reject invalid signature hex', () => {
    const params = makeParams();
    const record = store.record(params, relayKeys.secretKey);

    const tampered = { ...record, relay_signature: 'deadbeef' };
    expect(store.verify(tampered, relayKeys.publicKey)).toBe(false);
  });

  // ---- Get by request_id ----

  it('should get a witness by request_id', () => {
    const params = makeParams();
    store.record(params, relayKeys.secretKey);

    const retrieved = store.get(params.request_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.request_id).toBe(params.request_id);
    expect(retrieved!.model).toBe(params.model);
    expect(retrieved!.input_tokens).toBe(params.input_tokens);
  });

  it('should return null for non-existent request_id', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  // ---- List with filters ----

  it('should list all witnesses', () => {
    const consumer = toHex(generateSigningKeyPair().publicKey);
    store.record(makeParams({ consumer_pubkey: consumer }), relayKeys.secretKey);
    store.record(makeParams({ consumer_pubkey: consumer }), relayKeys.secretKey);
    store.record(makeParams(), relayKeys.secretKey);

    const all = store.list();
    expect(all.length).toBe(3);
  });

  it('should filter by consumer', () => {
    const consumer = toHex(generateSigningKeyPair().publicKey);
    store.record(makeParams({ consumer_pubkey: consumer }), relayKeys.secretKey);
    store.record(makeParams({ consumer_pubkey: consumer }), relayKeys.secretKey);
    store.record(makeParams(), relayKeys.secretKey);

    const filtered = store.list({ consumer });
    expect(filtered.length).toBe(2);
    expect(filtered.every((r) => r.consumer_pubkey === consumer)).toBe(true);
  });

  it('should filter by provider', () => {
    const provider = toHex(generateSigningKeyPair().publicKey);
    store.record(makeParams({ provider_pubkey: provider }), relayKeys.secretKey);
    store.record(makeParams(), relayKeys.secretKey);

    const filtered = store.list({ provider });
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.provider_pubkey).toBe(provider);
  });

  it('should filter by since', () => {
    const oldTime = Date.now() - 100_000;
    const newTime = Date.now();

    store.record(makeParams({ timestamp: oldTime }), relayKeys.secretKey);
    store.record(makeParams({ timestamp: newTime }), relayKeys.secretKey);

    const filtered = store.list({ since: newTime - 1 });
    expect(filtered.length).toBe(1);
  });

  it('should support pagination', () => {
    for (let i = 0; i < 5; i++) {
      store.record(makeParams(), relayKeys.secretKey);
    }

    const page1 = store.list({ limit: 2 });
    const page2 = store.list({ limit: 2, offset: 2 });
    const page3 = store.list({ limit: 2, offset: 4 });

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page3.length).toBe(1);

    // All unique request_ids
    const ids = new Set([...page1, ...page2, ...page3].map((r) => r.request_id));
    expect(ids.size).toBe(5);
  });

  // ---- Stats ----

  it('should compute aggregate stats', () => {
    const consumer1 = toHex(generateSigningKeyPair().publicKey);
    const consumer2 = toHex(generateSigningKeyPair().publicKey);
    const provider1 = toHex(generateSigningKeyPair().publicKey);

    store.record(
      makeParams({ consumer_pubkey: consumer1, provider_pubkey: provider1, input_tokens: 100, output_tokens: 50 }),
      relayKeys.secretKey,
    );
    store.record(
      makeParams({ consumer_pubkey: consumer2, provider_pubkey: provider1, input_tokens: 200, output_tokens: 100 }),
      relayKeys.secretKey,
    );

    const s = store.stats();
    expect(s.total_requests).toBe(2);
    expect(s.total_input_tokens).toBe(300);
    expect(s.total_output_tokens).toBe(150);
    expect(s.unique_consumers).toBe(2);
    expect(s.unique_providers).toBe(1);
  });

  it('should compute stats with filters', () => {
    const consumer = toHex(generateSigningKeyPair().publicKey);
    store.record(makeParams({ consumer_pubkey: consumer, input_tokens: 50 }), relayKeys.secretKey);
    store.record(makeParams({ input_tokens: 200 }), relayKeys.secretKey);

    const s = store.stats({ consumer });
    expect(s.total_requests).toBe(1);
    expect(s.total_input_tokens).toBe(50);
  });

  it('should return zero stats for empty store', () => {
    const s = store.stats();
    expect(s.total_requests).toBe(0);
    expect(s.total_input_tokens).toBe(0);
    expect(s.total_output_tokens).toBe(0);
    expect(s.unique_consumers).toBe(0);
    expect(s.unique_providers).toBe(0);
  });

  // ---- Prune ----

  it('should prune old records', () => {
    const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
    const newTime = Date.now();

    store.record(makeParams({ timestamp: oldTime }), relayKeys.secretKey);
    store.record(makeParams({ timestamp: oldTime - 1000 }), relayKeys.secretKey);
    store.record(makeParams({ timestamp: newTime }), relayKeys.secretKey);

    const pruned = store.prune(); // default 30 days
    expect(pruned).toBe(2);

    const remaining = store.list();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.timestamp).toBe(newTime);
  });

  it('should prune with custom retention', () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    store.record(makeParams({ timestamp: oneHourAgo }), relayKeys.secretKey);
    store.record(makeParams({ timestamp: Date.now() }), relayKeys.secretKey);

    const pruned = store.prune(30 * 60 * 1000); // 30 min retention
    expect(pruned).toBe(1);
  });

  it('should return 0 when nothing to prune', () => {
    store.record(makeParams(), relayKeys.secretKey);
    const pruned = store.prune();
    expect(pruned).toBe(0);
  });

  // ---- Export ----

  it('should export all records as JSON', () => {
    store.record(makeParams({ timestamp: 1000 }), relayKeys.secretKey);
    store.record(makeParams({ timestamp: 2000 }), relayKeys.secretKey);
    store.record(makeParams({ timestamp: 3000 }), relayKeys.secretKey);

    const exported = store.export();
    expect(exported.length).toBe(3);
    // Ordered by timestamp ASC
    expect(exported[0]!.timestamp).toBe(1000);
    expect(exported[2]!.timestamp).toBe(3000);
  });

  it('should export with since filter', () => {
    store.record(makeParams({ timestamp: 1000 }), relayKeys.secretKey);
    store.record(makeParams({ timestamp: 2000 }), relayKeys.secretKey);
    store.record(makeParams({ timestamp: 3000 }), relayKeys.secretKey);

    const exported = store.export({ since: 2000 });
    expect(exported.length).toBe(2);
    expect(exported[0]!.timestamp).toBe(2000);
  });

  it('should export with limit', () => {
    for (let i = 0; i < 5; i++) {
      store.record(makeParams({ timestamp: i * 1000 }), relayKeys.secretKey);
    }

    const exported = store.export({ limit: 3 });
    expect(exported.length).toBe(3);
  });

  it('should export records that are verifiable', () => {
    store.record(makeParams(), relayKeys.secretKey);
    const exported = store.export();

    expect(exported.length).toBe(1);
    expect(store.verify(exported[0]!, relayKeys.publicKey)).toBe(true);
  });
});
