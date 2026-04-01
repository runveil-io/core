import { describe, it, expect } from 'vitest';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  sign,
  verify,
  seal,
  open,
  sha256,
  toHex,
  fromHex,
  validatePublicKey,
} from '../src/crypto/index';

// =====================
// Existing tests (happy path)
// =====================

describe('crypto - existing tests', () => {
  it('generateSigningKeyPair returns correct key lengths', () => {
    const kp = generateSigningKeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(64);
  });

  it('generateEncryptionKeyPair returns correct key lengths', () => {
    const kp = generateEncryptionKeyPair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(32);
  });

  it('sign + verify roundtrip', () => {
    const kp = generateSigningKeyPair();
    const message = new TextEncoder().encode('hello world');
    const sig = sign(message, kp.secretKey);
    expect(verify(message, sig, kp.publicKey)).toBe(true);
  });

  it('verify with wrong key returns false', () => {
    const kp1 = generateSigningKeyPair();
    const kp2 = generateSigningKeyPair();
    const message = new TextEncoder().encode('hello world');
    const sig = sign(message, kp1.secretKey);
    expect(verify(message, sig, kp2.publicKey)).toBe(false);
  });

  it('verify with tampered message returns false', () => {
    const kp = generateSigningKeyPair();
    const message = new TextEncoder().encode('hello world');
    const sig = sign(message, kp.secretKey);
    const tampered = new TextEncoder().encode('hello world!');
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
    const wrongRecipient = generateEncryptionKeyPair();
    const plaintext = new TextEncoder().encode('secret message');
    const sealed = seal(plaintext, recipient.publicKey, sender.secretKey);
    const opened = open(sealed, wrongRecipient.secretKey);
    expect(opened).toBeNull();
  });

  it('seal output has correct format (32 + 24 + plaintext + 16 MAC)', () => {
    const sender = generateEncryptionKeyPair();
    const recipient = generateEncryptionKeyPair();
    const plaintext = new TextEncoder().encode('test');
    const sealed = seal(plaintext, recipient.publicKey, sender.secretKey);
    // 32 (pubkey) + 24 (nonce) + plaintext.length + 16 (MAC)
    expect(sealed.length).toBe(32 + 24 + plaintext.length + 16);
  });
});

// =====================
// New validation tests
// =====================

describe('fromHex - validation', () => {
  it('accepts valid hex strings', () => {
    expect(fromHex('deadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(fromHex('00ff')).toEqual(new Uint8Array([0x00, 0xff]));
    expect(fromHex('AABB')).toEqual(new Uint8Array([0xaa, 0xbb]));
    expect(fromHex('')).toEqual(new Uint8Array([]));
  });

  it('rejects odd-length hex string', () => {
    expect(() => fromHex('abc')).toThrow('Invalid hex: string length must be even');
    expect(() => fromHex('a')).toThrow('Invalid hex: string length must be even');
  });

  it('rejects non-hex characters', () => {
    expect(() => fromHex('gggg')).toThrow('Invalid hex: contains invalid characters');
    expect(() => fromHex('zz00')).toThrow('Invalid hex: contains invalid characters');
    expect(() => fromHex('ab cd ef')).toThrow('Invalid hex: contains invalid characters');
  });

  it('rejects non-string input', () => {
    expect(() => fromHex(null as any)).toThrow('Invalid hex: input must be a string');
    expect(() => fromHex(undefined as any)).toThrow('Invalid hex: input must be a string');
    expect(() => fromHex(123 as any)).toThrow('Invalid hex: input must be a string');
  });
});

describe('sign - validation', () => {
  it('rejects secret key with wrong length', () => {
    const message = new TextEncoder().encode('test');
    const badKey = new Uint8Array(32);
    expect(() => sign(message, badKey)).toThrow(
      'Invalid signing secret key: expected 64 bytes, got 32'
    );
  });

  it('rejects null/undefined secret key', () => {
    const message = new TextEncoder().encode('test');
    expect(() => sign(message, null as any)).toThrow(
      'Invalid signing secret key: key must be a Uint8Array'
    );
    expect(() => sign(message, undefined as any)).toThrow(
      'Invalid signing secret key: key must be a Uint8Array'
    );
  });
});

describe('verify - validation', () => {
  it('rejects public key with wrong length', () => {
    const message = new TextEncoder().encode('test');
    const sig = new Uint8Array(64);
    const badKey = new Uint8Array(16);
    expect(() => verify(message, sig, badKey)).toThrow(
      'Invalid signing public key: expected 32 bytes, got 16'
    );
  });

  it('rejects null/undefined public key', () => {
    const message = new TextEncoder().encode('test');
    const sig = new Uint8Array(64);
    expect(() => verify(message, sig, null as any)).toThrow(
      'Invalid signing public key: key must be a Uint8Array'
    );
  });
});

describe('seal - validation', () => {
  it('rejects recipient public key with wrong length', () => {
    const sender = generateEncryptionKeyPair();
    const plaintext = new TextEncoder().encode('test');
    const badKey = new Uint8Array(16);
    expect(() => seal(plaintext, badKey, sender.secretKey)).toThrow(
      'Invalid encryption public key: expected 32 bytes, got 16'
    );
  });

  it('rejects null recipient public key', () => {
    const sender = generateEncryptionKeyPair();
    const plaintext = new TextEncoder().encode('test');
    expect(() => seal(plaintext, null as any, sender.secretKey)).toThrow(
      'Invalid encryption public key: key must be a Uint8Array'
    );
  });
});

describe('open - validation', () => {
  it('rejects secret key with wrong length', () => {
    const sealed = new Uint8Array(100);
    const badKey = new Uint8Array(64);
    expect(() => open(sealed, badKey)).toThrow(
      'Invalid encryption secret key: expected 32 bytes, got 64'
    );
  });

  it('rejects null/undefined secret key', () => {
    const sealed = new Uint8Array(100);
    expect(() => open(sealed, null as any)).toThrow(
      'Invalid encryption secret key: key must be a Uint8Array'
    );
  });

  it('rejects sealed data shorter than minimum length', () => {
    const recipientKp = generateEncryptionKeyPair();
    const tooShort = new Uint8Array(30);
    expect(() => open(tooShort, recipientKp.secretKey)).toThrow(
      'Invalid sealed data: minimum length is 56 bytes, got 30'
    );
  });
});

describe('validatePublicKey', () => {
  it('accepts valid 32-byte key', () => {
    const key = new Uint8Array(32);
    expect(() => validatePublicKey(key, 'signing')).not.toThrow();
    expect(() => validatePublicKey(key, 'encryption')).not.toThrow();
  });

  it('rejects wrong-length key with descriptive error', () => {
    const key = new Uint8Array(48);
    expect(() => validatePublicKey(key, 'signing')).toThrow(
      'Invalid signing public key: expected 32 bytes, got 48'
    );
  });

  it('rejects null input', () => {
    expect(() => validatePublicKey(null as any, 'encryption')).toThrow(
      'Invalid encryption public key: key must be a Uint8Array'
    );
  });
});
