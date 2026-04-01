import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  validateProviderConfig,
  validateWalletFile,
} from '../src/config/validator.js';

describe('validateConfig', () => {
  const validConfig = {
    relay_url: 'wss://relay-jp.runveil.io',
    gateway_port: 9960,
    consumer_pubkey: 'a'.repeat(64),
    encryption_pubkey: 'b'.repeat(64),
  };

  it('should pass with a valid config', () => {
    const result = validateConfig(validConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should fail when config is null', () => {
    const result = validateConfig(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('config');
  });

  it('should fail when config is not an object', () => {
    const result = validateConfig('string');
    expect(result.valid).toBe(false);
  });

  it('should report all missing required fields at once', () => {
    const result = validateConfig({});
    expect(result.valid).toBe(false);
    const fields = result.errors.map((e) => e.field);
    expect(fields).toContain('relay_url');
    expect(fields).toContain('gateway_port');
    expect(fields).toContain('consumer_pubkey');
    expect(fields).toContain('encryption_pubkey');
    expect(result.errors).toHaveLength(4);
  });

  it('should fail when relay_url is not a ws/wss URL', () => {
    const result = validateConfig({ ...validConfig, relay_url: 'http://bad.url' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('relay_url');
    expect(result.errors[0]!.message).toContain('ws://');
  });

  it('should fail when relay_url is not a string', () => {
    const result = validateConfig({ ...validConfig, relay_url: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('relay_url');
  });

  it('should fail when gateway_port is out of range', () => {
    const result = validateConfig({ ...validConfig, gateway_port: 70000 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('gateway_port');
    expect(result.errors[0]!.message).toContain('65535');
  });

  it('should fail when gateway_port is not an integer', () => {
    const result = validateConfig({ ...validConfig, gateway_port: 3.14 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('gateway_port');
  });

  it('should fail when consumer_pubkey is not valid hex', () => {
    const result = validateConfig({ ...validConfig, consumer_pubkey: 'zz' + 'a'.repeat(62) });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('consumer_pubkey');
  });

  it('should fail when consumer_pubkey is wrong length', () => {
    const result = validateConfig({ ...validConfig, consumer_pubkey: 'aabb' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('consumer_pubkey');
    expect(result.errors[0]!.message).toContain('64');
  });

  it('should fail when encryption_pubkey is invalid', () => {
    const result = validateConfig({ ...validConfig, encryption_pubkey: 'not-hex' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('encryption_pubkey');
  });

  it('should produce a formatted error message', () => {
    const result = validateConfig({});
    expect(result.format()).toContain('Config validation failed');
    expect(result.format()).toContain('relay_url');
  });

  it('should accept ws:// URL', () => {
    const result = validateConfig({ ...validConfig, relay_url: 'ws://localhost:8080' });
    expect(result.valid).toBe(true);
  });
});

describe('validateProviderConfig', () => {
  const validProvider = {
    version: 1,
    models: ['claude-sonnet-4-20250514'],
    api_keys: [{ provider: 'anthropic', salt: 'aa', iv: 'bb', ciphertext: 'cc', tag: 'dd' }],
    max_concurrent: 5,
  };

  it('should pass with a valid provider config', () => {
    const result = validateProviderConfig(validProvider);
    expect(result.valid).toBe(true);
  });

  it('should fail when null', () => {
    const result = validateProviderConfig(null);
    expect(result.valid).toBe(false);
  });

  it('should report all missing fields', () => {
    const result = validateProviderConfig({});
    const fields = result.errors.map((e) => e.field);
    expect(fields).toContain('version');
    expect(fields).toContain('models');
    expect(fields).toContain('api_keys');
  });

  it('should fail when version is not 1', () => {
    const result = validateProviderConfig({ ...validProvider, version: 2 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('version');
  });

  it('should fail when models is empty', () => {
    const result = validateProviderConfig({ ...validProvider, models: [] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('models');
  });

  it('should fail when max_concurrent is invalid', () => {
    const result = validateProviderConfig({ ...validProvider, max_concurrent: -1 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('max_concurrent');
  });
});

describe('validateWalletFile', () => {
  const validWallet = {
    version: 1,
    kdf: 'scrypt',
    kdf_params: { N: 16384, r: 8, p: 1 },
    salt: 'aabb',
    iv: 'ccdd',
    ciphertext: 'eeff',
    tag: '1122',
  };

  it('should pass with valid wallet file', () => {
    const result = validateWalletFile(validWallet);
    expect(result.valid).toBe(true);
  });

  it('should fail when null', () => {
    const result = validateWalletFile(null);
    expect(result.valid).toBe(false);
  });

  it('should fail when kdf is not scrypt', () => {
    const result = validateWalletFile({ ...validWallet, kdf: 'argon2' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('kdf');
  });

  it('should fail when hex fields are missing', () => {
    const { salt, ...noSalt } = validWallet;
    const result = validateWalletFile(noSalt);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'salt')).toBe(true);
  });

  it('should fail when hex field contains non-hex chars', () => {
    const result = validateWalletFile({ ...validWallet, tag: 'ZZZZ' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'tag')).toBe(true);
  });

  it('should fail when kdf_params.N is not integer', () => {
    const result = validateWalletFile({ ...validWallet, kdf_params: { N: 1.5, r: 8, p: 1 } });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'kdf_params.N')).toBe(true);
  });
});
