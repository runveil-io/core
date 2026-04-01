import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WitnessStore } from '../src/relay/witness.js';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  sign,
  toHex,
} from '../src/crypto/index.js';
import type { Wallet } from '../src/wallet/index.js';

describe('relay witness integration', () => {
  let tempDir: string;
  let witnessStore: WitnessStore;
  let relayWallet: Wallet;

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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'veil-relay-witness-int-'));
    relayWallet = makeWallet();
    witnessStore = new WitnessStore(join(tempDir, 'witness.db'));
  });

  afterEach(() => {
    witnessStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create a witness record when a request completes', () => {
    const consumerKeys = generateSigningKeyPair();
    const providerKeys = generateSigningKeyPair();
    const requestId = `req-${Date.now()}`;

    // Simulate what relay does after stream_end
    const record = witnessStore.record(
      {
        request_id: requestId,
        consumer_pubkey: toHex(consumerKeys.publicKey),
        provider_pubkey: toHex(providerKeys.publicKey),
        model: 'claude-sonnet-4-20250514',
        input_tokens: 150,
        output_tokens: 75,
        duration_ms: 800,
        timestamp: Date.now(),
        relay_pubkey: toHex(relayWallet.signingPublicKey),
      },
      relayWallet.signingSecretKey,
    );

    expect(record.relay_signature).toBeTruthy();

    // Verify the record can be retrieved (simulates GET /witness/:requestId)
    const retrieved = witnessStore.get(requestId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.request_id).toBe(requestId);
    expect(retrieved!.input_tokens).toBe(150);
    expect(retrieved!.output_tokens).toBe(75);
    expect(retrieved!.duration_ms).toBe(800);

    // Verify signature is valid
    expect(witnessStore.verify(retrieved!, relayWallet.signingPublicKey)).toBe(true);
  });

  it('should return correct stats (simulates GET /witness/stats)', () => {
    const consumer1 = toHex(generateSigningKeyPair().publicKey);
    const consumer2 = toHex(generateSigningKeyPair().publicKey);
    const provider1 = toHex(generateSigningKeyPair().publicKey);
    const provider2 = toHex(generateSigningKeyPair().publicKey);

    // Simulate multiple completed requests
    for (let i = 0; i < 3; i++) {
      witnessStore.record(
        {
          request_id: `req-a-${i}`,
          consumer_pubkey: consumer1,
          provider_pubkey: provider1,
          model: 'claude-sonnet-4-20250514',
          input_tokens: 100,
          output_tokens: 50,
          duration_ms: 500 + i * 100,
          timestamp: Date.now() + i,
          relay_pubkey: toHex(relayWallet.signingPublicKey),
        },
        relayWallet.signingSecretKey,
      );
    }

    witnessStore.record(
      {
        request_id: 'req-b-0',
        consumer_pubkey: consumer2,
        provider_pubkey: provider2,
        model: 'claude-opus-4-20250514',
        input_tokens: 200,
        output_tokens: 100,
        duration_ms: 1500,
        timestamp: Date.now() + 10,
        relay_pubkey: toHex(relayWallet.signingPublicKey),
      },
      relayWallet.signingSecretKey,
    );

    const stats = witnessStore.stats();
    expect(stats.total_requests).toBe(4);
    expect(stats.total_input_tokens).toBe(500); // 3*100 + 200
    expect(stats.total_output_tokens).toBe(250); // 3*50 + 100
    expect(stats.unique_consumers).toBe(2);
    expect(stats.unique_providers).toBe(2);
  });

  it('should handle concurrent-style writes without conflicts', () => {
    // Simulate rapid sequential writes (as relay would do under load)
    const records: string[] = [];
    for (let i = 0; i < 50; i++) {
      const requestId = `req-concurrent-${i}`;
      witnessStore.record(
        {
          request_id: requestId,
          consumer_pubkey: toHex(generateSigningKeyPair().publicKey),
          provider_pubkey: toHex(generateSigningKeyPair().publicKey),
          model: 'claude-sonnet-4-20250514',
          input_tokens: 100 + i,
          output_tokens: 50 + i,
          duration_ms: 500,
          timestamp: Date.now() + i,
          relay_pubkey: toHex(relayWallet.signingPublicKey),
        },
        relayWallet.signingSecretKey,
      );
      records.push(requestId);
    }

    const stats = witnessStore.stats();
    expect(stats.total_requests).toBe(50);

    // Verify each record is retrievable
    for (const reqId of records) {
      const r = witnessStore.get(reqId);
      expect(r).not.toBeNull();
    }
  });

  it('should support export for on-chain migration', () => {
    // Record some witnesses
    for (let i = 0; i < 5; i++) {
      witnessStore.record(
        {
          request_id: `req-export-${i}`,
          consumer_pubkey: toHex(generateSigningKeyPair().publicKey),
          provider_pubkey: toHex(generateSigningKeyPair().publicKey),
          model: 'claude-sonnet-4-20250514',
          input_tokens: 100,
          output_tokens: 50,
          duration_ms: 500,
          timestamp: 1000 + i * 1000,
          relay_pubkey: toHex(relayWallet.signingPublicKey),
        },
        relayWallet.signingSecretKey,
      );
    }

    const exported = witnessStore.export();
    expect(exported.length).toBe(5);

    // Verify exported records are valid JSON-serializable
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json) as typeof exported;
    expect(parsed.length).toBe(5);

    // Each exported record should have a valid signature
    for (const record of exported) {
      expect(witnessStore.verify(record, relayWallet.signingPublicKey)).toBe(true);
    }
  });
});
