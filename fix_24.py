// src/crypto/index.ts

import * as nacl from 'tweetnacl';
import { isHexString } from 'hex-regex';

function validatePublicKey(key: Uint8Array, type: string): void {
  if (key.length !== 32) {
    throw new Error(`Invalid ${type} key length: expected 32 bytes, got ${key.length} bytes`);
  }
}

function fromHex(hex: string): Uint8Array {
  if (!isHexString(hex) || hex.length % 2 !== 0) {
    throw new Error(`Invalid hex: ${hex}`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  if (secretKey.length !== 64) {
    throw new Error(`Invalid secretKey length: expected 64 bytes, got ${secretKey.length} bytes`);
  }
  return nacl.sign(message, secretKey);
}

function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  validatePublicKey(publicKey, 'public');
  return nacl.sign.detached.verify(message, signature, publicKey);
}

function seal(publicKey: Uint8Array, message: Uint8Array): Uint8Array {
  validatePublicKey(publicKey, 'encryption');
  return nacl.box(message, nacl.randomBytes(nacl.box.nonceLength), publicKey, nacl.randomBytes(nacl.box.secretKeyLength));
}

function open(secretKey: Uint8Array, sealedData: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array): Uint8Array | null {
  if (secretKey.length !== 32) {
    throw new Error(`Invalid secretKey length: expected 32 bytes, got ${secretKey.length} bytes`);
  }
  if (sealedData.length < nacl.box.overheadLength) {
    throw new Error(`Invalid sealed data length: expected at least ${nacl.box.overheadLength} bytes, got ${sealedData.length} bytes`);
  }
  return nacl.box.open(sealedData, nonce, publicKey, secretKey);
}

export { fromHex, sign, verify, seal, open };