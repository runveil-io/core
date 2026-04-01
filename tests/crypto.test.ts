import { describe, it, expect } from 'vitest';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  sign,
  verify,
  seal,
  open,
  toHex,
  fromHex,
} from '../src/crypto/index.js';

describe('crypto', () => {
  it('generateSigningKeyPair returns 32-byte public, 64-byte secret', () => {
    const kp = generateSigningKeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(64);
  });

  it('generateEncryptionKeyPair returns 32-byte public, 32-byte secret', () => {
    const kp = generateEncryptionKeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(32);
  });

  it('sign + verify roundtrip', () => {
    const kp = generateSigningKeyPair();
    const msg = new TextEncoder().encode('hello world');
    const sig = sign(msg, kp.secretKey);
    expect(verify(msg, sig, kp.publicKey)).toBe(true);
  });

  it('verify with wrong key returns false', () => {
    const kp1 = generateSigningKeyPair();
    const kp2 = generateSigningKeyPair();
    const msg = new TextEncoder().encode('hello');
    const sig = sign(msg, kp1.secretKey);
    expect(verify(msg, sig, kp2.publicKey)).toBe(false);
  });

  it('verify with tampered message returns false', () => {
    const kp = generateSigningKeyPair();
    const msg = new TextEncoder().encode('hello');
    const sig = sign(msg, kp.secretKey);
    const tampered = new TextEncoder().encode('hellx');
    expect(verify(tampered, sig, kp.publicKey)).toBe(false);
  });

  it('seal + open roundtrip', () => {
    const sender = generateEncryptionKeyPair();
    const recipient = generateEncryptionKeyPair();
    const plaintext = new TextEncoder().encode('secret message');
    const sealed = seal(plaintext, recipient.publicKey, sender.secretKey);
    const opened = open(sealed, recipient.secretKey);
    expect(opened).not.toBeNull();
    expect(new TextDecoder().decode(opened!)).toBe('secret message');
  });

  it('open with wrong key returns null', () => {
    const sender = generateEncryptionKeyPair();
    const recipient = generateEncryptionKeyPair();
    const wrong = generateEncryptionKeyPair();
    const plaintext = new TextEncoder().encode('secret');
    const sealed = seal(plaintext, recipient.publicKey, sender.secretKey);
    expect(open(sealed, wrong.secretKey)).toBeNull();
  });

  it('seal output format: 32 sender pubkey + 24 nonce + ciphertext', () => {
    const sender = generateEncryptionKeyPair();
    const recipient = generateEncryptionKeyPair();
    const plaintext = new TextEncoder().encode('test');
    const sealed = seal(plaintext, recipient.publicKey, sender.secretKey);

    // First 32 bytes should be sender's public key
    const embeddedPubkey = sealed.slice(0, 32);
    expect(toHex(embeddedPubkey)).toBe(toHex(sender.publicKey));

    // Total length: 32 + 24 + (plaintext.length + 16 MAC)
    expect(sealed.length).toBe(32 + 24 + plaintext.length + 16);
  });

  describe('input validation', () => {
    it('fromHex validates input format', () => {
      expect(() => fromHex(null as any)).toThrow('Invalid hex: input must be a string');
      expect(() => fromHex('123')).toThrow('Invalid hex: length must be even, got 3');
      expect(() => fromHex('123x')).toThrow('Invalid hex: contains non-hexadecimal characters');
    });

    it('sign validates secret key length', () => {
      const msg = new Uint8Array([1, 2, 3]);
      const badKey = new Uint8Array(63);
      expect(() => sign(msg, badKey)).toThrow('Invalid sign secretKey length: expected 64 bytes, got 63');
    });

    it('verify validates public key length', () => {
      const msg = new Uint8Array([1, 2, 3]);
      const sig = new Uint8Array(64);
      const badKey = new Uint8Array(31);
      expect(() => verify(msg, sig, badKey)).toThrow('Invalid verify publicKey length: expected 32 bytes, got 31');
    });

    it('seal validates key lengths', () => {
      const pt = new Uint8Array([1]);
      const pub = new Uint8Array(32);
      const sec = new Uint8Array(32);
      expect(() => seal(pt, new Uint8Array(31), sec)).toThrow('Invalid seal recipientPubkey length');
      expect(() => seal(pt, pub, new Uint8Array(33))).toThrow('Invalid seal senderSecretKey length');
    });

    it('open validates inputs', () => {
      const sec = new Uint8Array(32);
      expect(() => open(new Uint8Array(55), sec)).toThrow('Invalid sealed data: minimum length is 56 bytes, got 55');
      expect(() => open(new Uint8Array(56), new Uint8Array(31))).toThrow('Invalid open recipientSecretKey length');
    });
  });
});
