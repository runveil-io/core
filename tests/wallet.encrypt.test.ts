import { describe, it, expect } from 'vitest';
import {
  deriveKey,
  encryptWallet,
  decryptWallet,
  changePassword,
  isEncryptedFormat,
  parseLegacyWallet,
  type WalletData,
  type EncryptedWallet,
} from '../src/wallet/encrypt.js';

const sampleWalletData: WalletData = {
  signingPublicKey: 'a'.repeat(64),
  signingSecretKey: 'b'.repeat(128),
  encryptionPublicKey: 'c'.repeat(64),
  encryptionSecretKey: 'd'.repeat(64),
};

describe('deriveKey', () => {
  it('produces consistent output for same inputs', () => {
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const params = { N: 16384, r: 8, p: 1 };
    const key1 = deriveKey('password123', salt, params);
    const key2 = deriveKey('password123', salt, params);
    expect(key1.toString('hex')).toBe(key2.toString('hex'));
    expect(key1.length).toBe(32);
  });

  it('produces different output for different passwords', () => {
    const salt = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const params = { N: 16384, r: 8, p: 1 };
    const key1 = deriveKey('password1', salt, params);
    const key2 = deriveKey('password2', salt, params);
    expect(key1.toString('hex')).not.toBe(key2.toString('hex'));
  });

  it('produces different output for different salts', () => {
    const salt1 = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const salt2 = Buffer.from('fedcba9876543210fedcba9876543210', 'hex');
    const params = { N: 16384, r: 8, p: 1 };
    const key1 = deriveKey('password', salt1, params);
    const key2 = deriveKey('password', salt2, params);
    expect(key1.toString('hex')).not.toBe(key2.toString('hex'));
  });
});

describe('encryptWallet / decryptWallet', () => {
  it('encrypt → decrypt roundtrip preserves data', () => {
    const encrypted = encryptWallet(sampleWalletData, 'strongpassword!');
    const decrypted = decryptWallet(encrypted, 'strongpassword!');
    expect(decrypted).toEqual(sampleWalletData);
  });

  it('wrong password throws clear error', () => {
    const encrypted = encryptWallet(sampleWalletData, 'correctpassword');
    expect(() => decryptWallet(encrypted, 'wrongpassword')).toThrow(
      /Decryption failed: wrong password or corrupted wallet file/,
    );
  });

  it('encrypted wallet has correct format fields', () => {
    const encrypted = encryptWallet(sampleWalletData, 'password12345');
    expect(encrypted.version).toBe(1);
    expect(encrypted.kdf).toBe('scrypt');
    expect(encrypted.cipher).toBe('aes-256-gcm');
    expect(encrypted.kdf_params.N).toBeGreaterThan(0);
    expect(encrypted.kdf_params.r).toBe(8);
    expect(encrypted.kdf_params.p).toBe(1);
    expect(encrypted.kdf_params.salt).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
    expect(encrypted.iv).toMatch(/^[0-9a-f]{24}$/);               // 12 bytes hex
    expect(encrypted.tag).toMatch(/^[0-9a-f]{32}$/);              // 16 bytes hex
    expect(encrypted.ciphertext.length).toBeGreaterThan(0);
  });

  it('each encryption produces different ciphertext (random salt/IV)', () => {
    const enc1 = encryptWallet(sampleWalletData, 'password12345');
    const enc2 = encryptWallet(sampleWalletData, 'password12345');
    expect(enc1.kdf_params.salt).not.toBe(enc2.kdf_params.salt);
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it('tampered ciphertext → auth tag failure', () => {
    const encrypted = encryptWallet(sampleWalletData, 'password12345');
    // Flip a byte in ciphertext
    const chars = encrypted.ciphertext.split('');
    chars[0] = chars[0] === '0' ? '1' : '0';
    const tampered: EncryptedWallet = { ...encrypted, ciphertext: chars.join('') };
    expect(() => decryptWallet(tampered, 'password12345')).toThrow(/Decryption failed/);
  });

  it('tampered tag → decryption failure', () => {
    const encrypted = encryptWallet(sampleWalletData, 'password12345');
    const chars = encrypted.tag.split('');
    chars[0] = chars[0] === '0' ? '1' : '0';
    const tampered: EncryptedWallet = { ...encrypted, tag: chars.join('') };
    expect(() => decryptWallet(tampered, 'password12345')).toThrow(/Decryption failed/);
  });

  it('tampered salt → wrong key → decryption failure', () => {
    const encrypted = encryptWallet(sampleWalletData, 'password12345');
    const chars = encrypted.kdf_params.salt.split('');
    chars[0] = chars[0] === '0' ? '1' : '0';
    const tampered: EncryptedWallet = {
      ...encrypted,
      kdf_params: { ...encrypted.kdf_params, salt: chars.join('') },
    };
    expect(() => decryptWallet(tampered, 'password12345')).toThrow(/Decryption failed/);
  });

  it('tampered IV → decryption failure', () => {
    const encrypted = encryptWallet(sampleWalletData, 'password12345');
    const chars = encrypted.iv.split('');
    chars[0] = chars[0] === '0' ? '1' : '0';
    const tampered: EncryptedWallet = { ...encrypted, iv: chars.join('') };
    expect(() => decryptWallet(tampered, 'password12345')).toThrow(/Decryption failed/);
  });
});

describe('changePassword', () => {
  it('re-encrypts without regenerating keys', () => {
    const encrypted = encryptWallet(sampleWalletData, 'oldpassword1');
    const reEncrypted = changePassword(encrypted, 'oldpassword1', 'newpassword1');

    // Old password should not work
    expect(() => decryptWallet(reEncrypted, 'oldpassword1')).toThrow(/Decryption failed/);

    // New password should work and return same keys
    const decrypted = decryptWallet(reEncrypted, 'newpassword1');
    expect(decrypted).toEqual(sampleWalletData);
  });

  it('wrong old password throws', () => {
    const encrypted = encryptWallet(sampleWalletData, 'correctpass1');
    expect(() => changePassword(encrypted, 'wrongpass!!!', 'newpassword1')).toThrow(
      /Decryption failed/,
    );
  });

  it('uses fresh salt and IV', () => {
    const encrypted = encryptWallet(sampleWalletData, 'password1234');
    const reEncrypted = changePassword(encrypted, 'password1234', 'newpassword!');
    expect(reEncrypted.kdf_params.salt).not.toBe(encrypted.kdf_params.salt);
    expect(reEncrypted.iv).not.toBe(encrypted.iv);
  });
});

describe('isEncryptedFormat', () => {
  it('returns true for encrypted format', () => {
    const encrypted = encryptWallet(sampleWalletData, 'password12345');
    expect(isEncryptedFormat(encrypted as unknown as Record<string, unknown>)).toBe(true);
  });

  it('returns false for legacy plaintext', () => {
    expect(isEncryptedFormat(sampleWalletData as unknown as Record<string, unknown>)).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isEncryptedFormat({})).toBe(false);
  });
});

describe('parseLegacyWallet', () => {
  it('parses valid legacy wallet', () => {
    const result = parseLegacyWallet(sampleWalletData as unknown as Record<string, unknown>);
    expect(result).toEqual(sampleWalletData);
  });

  it('throws on missing fields', () => {
    expect(() => parseLegacyWallet({ signingPublicKey: 'abc' })).toThrow(/missing/);
  });
});
