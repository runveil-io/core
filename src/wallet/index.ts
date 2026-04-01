import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  toHex,
  fromHex,
} from '../crypto/index.js';
import {
  encryptWallet,
  decryptWallet,
  changePassword as changeEncryptionPassword,
  isEncryptedFormat,
  parseLegacyWallet,
  type EncryptedWallet,
  type WalletData,
} from './encrypt.js';

export type { EncryptedWallet, WalletData } from './encrypt.js';
export { encryptWallet, decryptWallet, isEncryptedFormat, parseLegacyWallet } from './encrypt.js';

export interface Wallet {
  signingPublicKey: Uint8Array;
  signingSecretKey: Uint8Array;
  encryptionPublicKey: Uint8Array;
  encryptionSecretKey: Uint8Array;
}

export interface WalletPublicInfo {
  signingPublicKey: string;
  encryptionPublicKey: string;
}

// N=2^14 for test compat; production should use N=2^17
const KDF_N = Number(process.env['VEIL_KDF_N'] ?? 16384);
const KDF_PARAMS = { N: KDF_N, r: 8, p: 1 };

function getVeilHome(veilHome?: string): string {
  return veilHome ?? join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.', '.veil');
}

/**
 * Create a new encrypted wallet.
 */
export async function createWallet(password: string, veilHome?: string): Promise<WalletPublicInfo> {
  const home = getVeilHome(veilHome);

  if (existsSync(join(home, 'wallet.json'))) {
    throw new Error('Already initialized. Use --force to reinitialize.');
  }

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'data'), { recursive: true });

  const signing = generateSigningKeyPair();
  const encryption = generateEncryptionKeyPair();

  const walletData: WalletData = {
    signingPublicKey: toHex(signing.publicKey),
    signingSecretKey: toHex(signing.secretKey),
    encryptionPublicKey: toHex(encryption.publicKey),
    encryptionSecretKey: toHex(encryption.secretKey),
  };

  const encrypted = encryptWallet(walletData, password);
  writeFileSync(join(home, 'wallet.json'), JSON.stringify(encrypted, null, 2), { mode: 0o600 });

  const config = {
    relay_url: 'wss://relay-jp.runveil.io',
    gateway_port: 9960,
    consumer_pubkey: toHex(signing.publicKey),
    encryption_pubkey: toHex(encryption.publicKey),
  };

  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });

  return {
    signingPublicKey: toHex(signing.publicKey),
    encryptionPublicKey: toHex(encryption.publicKey),
  };
}

/**
 * Load and decrypt wallet from disk.
 * Supports both encrypted (v1) and legacy plaintext formats.
 */
export async function loadWallet(password: string, veilHome?: string): Promise<Wallet> {
  const home = getVeilHome(veilHome);
  const walletPath = join(home, 'wallet.json');

  if (!existsSync(walletPath)) {
    throw new Error("Run 'veil init' first.");
  }

  const raw = JSON.parse(readFileSync(walletPath, 'utf-8'));
  let keys: WalletData;

  if (isEncryptedFormat(raw)) {
    keys = decryptWallet(raw as EncryptedWallet, password);
  } else {
    // Legacy plaintext format — decrypt not needed but we migrate
    keys = parseLegacyWallet(raw);
  }

  return {
    signingPublicKey: fromHex(keys.signingPublicKey),
    signingSecretKey: fromHex(keys.signingSecretKey),
    encryptionPublicKey: fromHex(keys.encryptionPublicKey),
    encryptionSecretKey: fromHex(keys.encryptionSecretKey),
  };
}

/**
 * Detect if the wallet on disk is the old unencrypted format.
 */
export function isLegacyWallet(veilHome?: string): boolean {
  const home = getVeilHome(veilHome);
  const walletPath = join(home, 'wallet.json');

  if (!existsSync(walletPath)) return false;

  const raw = JSON.parse(readFileSync(walletPath, 'utf-8'));
  return !isEncryptedFormat(raw);
}

/**
 * Migrate a legacy plaintext wallet to the encrypted format.
 */
export async function migrateWallet(password: string, veilHome?: string): Promise<void> {
  const home = getVeilHome(veilHome);
  const walletPath = join(home, 'wallet.json');

  if (!existsSync(walletPath)) {
    throw new Error("No wallet found. Run 'veil init' first.");
  }

  const raw = JSON.parse(readFileSync(walletPath, 'utf-8'));
  if (isEncryptedFormat(raw)) {
    throw new Error('Wallet is already encrypted.');
  }

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  const keys = parseLegacyWallet(raw);
  const encrypted = encryptWallet(keys, password);
  writeFileSync(walletPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
}

/**
 * Export the wallet as encrypted JSON (for backup).
 */
export async function exportWallet(password: string, veilHome?: string): Promise<EncryptedWallet> {
  const home = getVeilHome(veilHome);
  const walletPath = join(home, 'wallet.json');

  if (!existsSync(walletPath)) {
    throw new Error("No wallet found. Run 'veil init' first.");
  }

  const raw = JSON.parse(readFileSync(walletPath, 'utf-8'));

  if (isEncryptedFormat(raw)) {
    // Verify password by decrypting
    const keys = decryptWallet(raw as EncryptedWallet, password);
    // Re-encrypt with fresh salt/IV for the export
    return encryptWallet(keys, password);
  } else {
    // Legacy: encrypt with given password
    const keys = parseLegacyWallet(raw);
    return encryptWallet(keys, password);
  }
}

/**
 * Change the wallet password on disk.
 */
export async function changeWalletPassword(
  oldPassword: string,
  newPassword: string,
  veilHome?: string,
): Promise<void> {
  const home = getVeilHome(veilHome);
  const walletPath = join(home, 'wallet.json');

  if (!existsSync(walletPath)) {
    throw new Error("No wallet found. Run 'veil init' first.");
  }

  if (newPassword.length < 8) {
    throw new Error('New password must be at least 8 characters.');
  }

  const raw = JSON.parse(readFileSync(walletPath, 'utf-8'));

  if (!isEncryptedFormat(raw)) {
    throw new Error('Wallet is not encrypted. Migrate first.');
  }

  const newEncrypted = changeEncryptionPassword(raw as EncryptedWallet, oldPassword, newPassword);
  writeFileSync(walletPath, JSON.stringify(newEncrypted, null, 2), { mode: 0o600 });
}

export function getPublicKeys(veilHome?: string): WalletPublicInfo {
  const home = getVeilHome(veilHome);
  const configPath = join(home, 'config.json');

  if (!existsSync(configPath)) {
    throw new Error("Not initialized. Run 'veil init'.");
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  return {
    signingPublicKey: config.consumer_pubkey,
    encryptionPublicKey: config.encryption_pubkey,
  };
}

// ============== API Key Encryption (unchanged) ==============

function encrypt(data: Buffer, password: string): { salt: string; iv: string; ciphertext: string; tag: string } {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, KDF_PARAMS);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    tag: tag.toString('hex'),
  };
}

function decrypt(enc: { salt: string; iv: string; ciphertext: string; tag: string }, password: string, kdfParams?: { N: number; r: number; p: number }): Buffer {
  const salt = Buffer.from(enc.salt, 'hex');
  const params = kdfParams ?? KDF_PARAMS;
  const key = scryptSync(password, salt, 32, params);
  const iv = Buffer.from(enc.iv, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, 'hex')),
    decipher.final(),
  ]);
}

export function encryptApiKey(
  apiKey: string,
  password: string,
): { salt: string; iv: string; ciphertext: string; tag: string } {
  return encrypt(Buffer.from(apiKey, 'utf-8'), password);
}

export function decryptApiKey(
  enc: { salt: string; iv: string; ciphertext: string; tag: string },
  password: string,
): string {
  return decrypt(enc, password).toString('utf-8');
}
