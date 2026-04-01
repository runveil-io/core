import nacl from 'tweetnacl';
import { createHash } from 'crypto';

// --- Validation Helpers ---

export function validatePublicKey(key: Uint8Array, type: 'signing' | 'encryption'): void {
  if (!key || !(key instanceof Uint8Array)) {
    throw new Error(`Invalid ${type} public key: key must be a Uint8Array`);
  }
  if (key.length !== 32) {
    throw new Error(
      `Invalid ${type} public key: expected 32 bytes, got ${key.length}`
    );
  }
}

function validateSecretKey(key: Uint8Array, expectedLength: number, purpose: string): void {
  if (!key || !(key instanceof Uint8Array)) {
    throw new Error(`Invalid ${purpose} secret key: key must be a Uint8Array`);
  }
  if (key.length !== expectedLength) {
    throw new Error(
      `Invalid ${purpose} secret key: expected ${expectedLength} bytes, got ${key.length}`
    );
  }
}

// --- Key Generation ---

export function generateSigningKeyPair() {
  return nacl.sign.keyPair();
}

export function generateEncryptionKeyPair() {
  return nacl.box.keyPair();
}

// --- Signing ---

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  validateSecretKey(secretKey, 64, 'signing');
  return nacl.sign.detached(message, secretKey);
}

export function verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): boolean {
  validatePublicKey(publicKey, 'signing');
  return nacl.sign.detached.verify(message, signature, publicKey);
}

// --- Encryption ---

export function seal(
  plaintext: Uint8Array,
  recipientPubkey: Uint8Array,
  senderSecretKey: Uint8Array
): Uint8Array {
  validatePublicKey(recipientPubkey, 'encryption');

  const senderKeypair = nacl.box.keyPair.fromSecretKey(senderSecretKey);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);

  const encrypted = nacl.box(plaintext, nonce, recipientPubkey, senderSecretKey);

  // sealed = senderPublicKey (32) + nonce (24) + ciphertext
  const sealed = new Uint8Array(32 + 24 + encrypted.length);
  sealed.set(senderKeypair.publicKey, 0);
  sealed.set(nonce, 32);
  sealed.set(encrypted, 56);

  return sealed;
}

export function open(
  sealed: Uint8Array,
  recipientSecretKey: Uint8Array
): Uint8Array | null {
  validateSecretKey(recipientSecretKey, 32, 'encryption');

  if (!sealed || !(sealed instanceof Uint8Array)) {
    throw new Error('Invalid sealed data: must be a Uint8Array');
  }
  if (sealed.length < 56) {
    throw new Error(
      `Invalid sealed data: minimum length is 56 bytes, got ${sealed.length}`
    );
  }

  const senderPubkey = sealed.slice(0, 32);
  const nonce = sealed.slice(32, 56);
  const ciphertext = sealed.slice(56);

  return nacl.box.open(ciphertext, nonce, senderPubkey, recipientSecretKey);
}

// --- Hashing ---

export function sha256(data: Uint8Array): Uint8Array {
  const hash = createHash('sha256').update(data).digest();
  return new Uint8Array(hash);
}

// --- Hex Encoding ---

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== 'string') {
    throw new Error('Invalid hex: input must be a string');
  }
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex: string length must be even');
  }
  if (hex.length > 0 && !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Invalid hex: contains invalid characters');
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
