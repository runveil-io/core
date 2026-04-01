import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isLegacyWallet, migrateWallet, loadWallet } from '../src/wallet/index.js';
import { isEncryptedFormat } from '../src/wallet/encrypt.js';

const legacyWallet = {
  signingPublicKey: 'a'.repeat(64),
  signingSecretKey: 'b'.repeat(128),
  encryptionPublicKey: 'c'.repeat(64),
  encryptionSecretKey: 'd'.repeat(64),
};

describe('wallet migration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'veil-migrate-'));
    mkdirSync(join(tempDir, 'data'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects old unencrypted wallet', () => {
    writeFileSync(join(tempDir, 'wallet.json'), JSON.stringify(legacyWallet));
    expect(isLegacyWallet(tempDir)).toBe(true);
  });

  it('does not flag encrypted wallet as legacy', async () => {
    // Create encrypted wallet via createWallet
    const { createWallet } = await import('../src/wallet/index.js');
    await createWallet('testpassword123', tempDir);
    expect(isLegacyWallet(tempDir)).toBe(false);
  });

  it('returns false when no wallet exists', () => {
    expect(isLegacyWallet(tempDir)).toBe(false);
  });

  it('migrates legacy wallet to encrypted format', async () => {
    writeFileSync(join(tempDir, 'wallet.json'), JSON.stringify(legacyWallet));

    await migrateWallet('migratepass1', tempDir);

    // File should now be encrypted
    const raw = JSON.parse(readFileSync(join(tempDir, 'wallet.json'), 'utf-8'));
    expect(isEncryptedFormat(raw)).toBe(true);
    expect(raw.version).toBe(1);
    expect(raw.kdf).toBe('scrypt');
    expect(raw.cipher).toBe('aes-256-gcm');
  });

  it('migrated wallet can be loaded with correct password', async () => {
    writeFileSync(join(tempDir, 'wallet.json'), JSON.stringify(legacyWallet));

    await migrateWallet('migratepass1', tempDir);

    const wallet = await loadWallet('migratepass1', tempDir);
    expect(Buffer.from(wallet.signingPublicKey).toString('hex')).toBe(legacyWallet.signingPublicKey);
    expect(Buffer.from(wallet.encryptionPublicKey).toString('hex')).toBe(legacyWallet.encryptionPublicKey);
  });

  it('migrated wallet rejects wrong password', async () => {
    writeFileSync(join(tempDir, 'wallet.json'), JSON.stringify(legacyWallet));

    await migrateWallet('migratepass1', tempDir);

    await expect(loadWallet('wrongpassword', tempDir)).rejects.toThrow(/Decryption failed/);
  });

  it('throws when trying to migrate already-encrypted wallet', async () => {
    const { createWallet } = await import('../src/wallet/index.js');
    await createWallet('testpassword123', tempDir);

    await expect(migrateWallet('newpassword1', tempDir)).rejects.toThrow(/already encrypted/);
  });

  it('throws on short password', async () => {
    writeFileSync(join(tempDir, 'wallet.json'), JSON.stringify(legacyWallet));
    await expect(migrateWallet('short', tempDir)).rejects.toThrow(/at least 8/);
  });
});
