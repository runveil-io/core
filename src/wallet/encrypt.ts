import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Wallet data: the plaintext keypairs stored in memory.
 */
export interface WalletData {
  signingPublicKey: string;    // hex
  signingSecretKey: string;    // hex
  encryptionPublicKey: string; // hex
  encryptionSecretKey: string; // hex
}

/**
 * Encrypted wallet file format (v1).
 */
export interface EncryptedWallet {
  version: 1;
  kdf: 'scrypt';
  kdf_params: {
    N: number;     // cost parameter (default 2^14 = 16384, configurable via env)
    r: number;     // block size (8)
    p: number;     // parallelization (1)
    salt: string;  // hex, 32 bytes random
  };
  cipher: 'aes-256-gcm';
  ciphertext: string;  // hex
  iv: string;          // hex, 12 bytes
  tag: string;         // hex, 16 bytes auth tag
}

// N=2^14 for test compat; production should use N=2^17
const DEFAULT_KDF_N = Number(process.env['VEIL_KDF_N'] ?? 16384);

function getDefaultKdfParams(): { N: number; r: number; p: number } {
  return { N: DEFAULT_KDF_N, r: 8, p: 1 };
}

/**
 * Derive a 256-bit encryption key from password + salt using scrypt.
 */
export function deriveKey(
  password: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Buffer {
  return scryptSync(password, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
  });
}

/**
 * Encrypt wallet data with a password.
 * Generates random salt (32 bytes) and IV (12 bytes) each time.
 */
export function encryptWallet(data: WalletData, password: string): EncryptedWallet {
  const params = getDefaultKdfParams();
  const salt = randomBytes(32);
  const key = deriveKey(password, salt, params);
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    kdf: 'scrypt',
    kdf_params: {
      N: params.N,
      r: params.r,
      p: params.p,
      salt: salt.toString('hex'),
    },
    cipher: 'aes-256-gcm',
    ciphertext: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt an encrypted wallet with the given password.
 * Throws a clear error on wrong password / tampered data.
 */
export function decryptWallet(encrypted: EncryptedWallet, password: string): WalletData {
  const salt = Buffer.from(encrypted.kdf_params.salt, 'hex');
  const key = deriveKey(password, salt, encrypted.kdf_params);
  const iv = Buffer.from(encrypted.iv, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));

  try {
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'hex')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf-8')) as WalletData;
  } catch {
    throw new Error('Decryption failed: wrong password or corrupted wallet file.');
  }
}

/**
 * Change wallet password: decrypt with old, re-encrypt with new.
 * Keys remain the same.
 */
export function changePassword(
  encrypted: EncryptedWallet,
  oldPassword: string,
  newPassword: string,
): EncryptedWallet {
  const data = decryptWallet(encrypted, oldPassword);
  return encryptWallet(data, newPassword);
}

/**
 * Detect whether a parsed wallet JSON is the new encrypted format or legacy plaintext.
 * Encrypted format has `version` field; legacy has raw key fields.
 */
export function isEncryptedFormat(walletJson: Record<string, unknown>): boolean {
  return walletJson['version'] !== undefined && walletJson['kdf'] !== undefined;
}

/**
 * Convert a legacy plaintext wallet file to WalletData.
 */
export function parseLegacyWallet(walletJson: Record<string, unknown>): WalletData {
  const required = ['signingPublicKey', 'signingSecretKey', 'encryptionPublicKey', 'encryptionSecretKey'];
  for (const key of required) {
    if (typeof walletJson[key] !== 'string') {
      throw new Error(`Invalid legacy wallet: missing ${key}`);
    }
  }
  return {
    signingPublicKey: walletJson['signingPublicKey'] as string,
    signingSecretKey: walletJson['signingSecretKey'] as string,
    encryptionPublicKey: walletJson['encryptionPublicKey'] as string,
    encryptionSecretKey: walletJson['encryptionSecretKey'] as string,
  };
}
