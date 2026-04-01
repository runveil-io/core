import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';

export function validateKeyLength(key: Uint8Array | null | undefined, expectedLength: number, name: string): void {
  if (!key) throw new Error(`Invalid ${name}: missing or null`);
  if (!(key instanceof Uint8Array)) throw new Error(`Invalid ${name}: must be Uint8Array`);
  if (key.length !== expectedLength) {
    throw new Error(`Invalid ${name} length: expected ${expectedLength} bytes, got ${key.length}`);
  }
}

export function validatePublicKey(key: Uint8Array | null | undefined, name: string = 'publicKey'): void {
  validateKeyLength(key, 32, name);
}

export function generateSigningKeyPair(): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  return nacl.sign.keyPair();
}

export function generateEncryptionKeyPair(): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  return nacl.box.keyPair();
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  validateKeyLength(secretKey, 64, 'sign secretKey');
  return nacl.sign.detached(message, secretKey);
}

export function verify(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  validatePublicKey(publicKey, 'verify publicKey');
  return nacl.sign.detached.verify(message, signature, publicKey);
}

export function seal(
  plaintext: Uint8Array,
  recipientPubkey: Uint8Array,
  senderSecretKey: Uint8Array,
): Uint8Array {
  validatePublicKey(recipientPubkey, 'seal recipientPubkey');
  validateKeyLength(senderSecretKey, 32, 'seal senderSecretKey');
  const senderKeyPair = nacl.box.keyPair.fromSecretKey(senderSecretKey);
  const nonce = nacl.randomBytes(24);
  const encrypted = nacl.box(plaintext, nonce, recipientPubkey, senderSecretKey);
  if (!encrypted) throw new Error('encryption_failed');

  const sealed = new Uint8Array(32 + 24 + encrypted.length);
  sealed.set(senderKeyPair.publicKey, 0);
  sealed.set(nonce, 32);
  sealed.set(encrypted, 56);
  return sealed;
}

export function open(
  sealed: Uint8Array,
  recipientSecretKey: Uint8Array,
): Uint8Array | null {
  validateKeyLength(recipientSecretKey, 32, 'open recipientSecretKey');
  if (!sealed || !(sealed instanceof Uint8Array) || sealed.length < 56) {
    throw new Error(`Invalid sealed data: minimum length is 56 bytes, got ${sealed?.length || 0}`);
  }
  const senderPubkey = sealed.slice(0, 32);
  const nonce = sealed.slice(32, 56);
  const ciphertext = sealed.slice(56);
  return nacl.box.open(ciphertext, nonce, senderPubkey, recipientSecretKey);
}

export function sha256(data: Uint8Array): Uint8Array {
  const hash = createHash('sha256').update(data).digest();
  return new Uint8Array(hash);
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== 'string') throw new Error('Invalid hex: input must be a string');
  if (hex.length % 2 !== 0) throw new Error(`Invalid hex: length must be even, got ${hex.length}`);
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('Invalid hex: contains non-hexadecimal characters');
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
