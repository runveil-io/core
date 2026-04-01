import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  validateProviderConfig,
  ConfigValidationError,
} from '../src/config/validate.js';

// ── helpers ──────────────────────────────────────────────────

function validConfig() {
  return {
    relay_url: 'wss://relay-jp.runveil.io',
    gateway_port: 9960,
    consumer_pubkey: 'a'.repeat(64),
    encryption_pubkey: 'b'.repeat(64),
  };
}

function validProviderConfig() {
  return {
    version: 1,
    models: ['claude-sonnet-4-20250514'],
    api_keys: [
      {
        provider: 'anthropic',
        salt: 'abc123',
        iv: 'def456',
        ciphertext: 'ghi789',
        tag: 'jkl012',
      },
    ],
    max_concurrent: 5,
    self_priority: true,
  };
}

// ── config.json ──────────────────────────────────────────────

describe('validateConfig', () => {
  it('accepts a valid config', () => {
    const cfg = validConfig();
    const result = validateConfig(cfg);
    expect(result.relay_url).toBe(cfg.relay_url);
    expect(result.gateway_port).toBe(cfg.gateway_port);
    expect(result.consumer_pubkey).toBe(cfg.consumer_pubkey);
    expect(result.encryption_pubkey).toBe(cfg.encryption_pubkey);
  });

  it('rejects non-object input', () => {
    expect(() => validateConfig(null)).toThrow(ConfigValidationError);
    expect(() => validateConfig('string')).toThrow(ConfigValidationError);
  });

  it('reports all missing required fields at once', () => {
    try {
      validateConfig({});
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const e = err as ConfigValidationError;
      expect(e.file).toBe('config.json');
      expect(e.errors).toHaveLength(1);
      expect(e.errors[0]).toContain('relay_url');
      expect(e.errors[0]).toContain('gateway_port');
      expect(e.errors[0]).toContain('consumer_pubkey');
      expect(e.errors[0]).toContain('encryption_pubkey');
    }
  });

  it('reports a subset of missing fields', () => {
    try {
      validateConfig({ relay_url: 'wss://example.com', gateway_port: 8080 });
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors[0]).toContain('consumer_pubkey');
      expect(e.errors[0]).toContain('encryption_pubkey');
      expect(e.errors[0]).not.toContain('relay_url');
    }
  });

  it('rejects wrong type for relay_url', () => {
    const cfg = { ...validConfig(), relay_url: 123 };
    try {
      validateConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors).toContain('relay_url must be a string');
    }
  });

  it('rejects invalid relay_url format', () => {
    const cfg = { ...validConfig(), relay_url: 'http://not-websocket.com' };
    try {
      validateConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors[0]).toContain('WebSocket URL');
    }
  });

  it('rejects wrong type for gateway_port', () => {
    const cfg = { ...validConfig(), gateway_port: 'not-a-number' };
    try {
      validateConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors).toContain('gateway_port must be an integer');
    }
  });

  it('rejects out-of-range gateway_port', () => {
    const cfg = { ...validConfig(), gateway_port: 99999 };
    try {
      validateConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors[0]).toContain('between 1 and 65535');
    }
  });

  it('rejects invalid consumer_pubkey (too short)', () => {
    const cfg = { ...validConfig(), consumer_pubkey: 'deadbeef' };
    try {
      validateConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors[0]).toContain('64-char hex');
    }
  });

  it('rejects invalid encryption_pubkey (non-hex chars)', () => {
    const cfg = { ...validConfig(), encryption_pubkey: 'g'.repeat(64) };
    try {
      validateConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors[0]).toContain('64-char hex');
    }
  });

  it('collects multiple errors in one throw', () => {
    const cfg = {
      relay_url: 'not-ws',
      gateway_port: -1,
      consumer_pubkey: 'short',
      encryption_pubkey: 42,
    };
    try {
      validateConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors.length).toBeGreaterThanOrEqual(4);
    }
  });
});

// ── provider.json ────────────────────────────────────────────

describe('validateProviderConfig', () => {
  it('accepts a valid provider config', () => {
    const cfg = validProviderConfig();
    const result = validateProviderConfig(cfg);
    expect(result.version).toBe(1);
    expect(result.models).toEqual(['claude-sonnet-4-20250514']);
  });

  it('reports all missing required fields at once', () => {
    try {
      validateProviderConfig({});
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.file).toBe('provider.json');
      expect(e.errors[0]).toContain('version');
      expect(e.errors[0]).toContain('models');
      expect(e.errors[0]).toContain('api_keys');
      expect(e.errors[0]).toContain('max_concurrent');
    }
  });

  it('rejects wrong type for models', () => {
    const cfg = { ...validProviderConfig(), models: 'not-array' };
    try {
      validateProviderConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors).toContain('models must be an array');
    }
  });

  it('rejects empty models array', () => {
    const cfg = { ...validProviderConfig(), models: [] };
    try {
      validateProviderConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors).toContain('models must contain at least one model');
    }
  });

  it('rejects non-string items in models', () => {
    const cfg = { ...validProviderConfig(), models: [123, true] };
    try {
      validateProviderConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors).toContain('models must be an array of strings');
    }
  });

  it('rejects api_keys entry with missing fields', () => {
    const cfg = {
      ...validProviderConfig(),
      api_keys: [{ provider: 'anthropic' }],
    };
    try {
      validateProviderConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors[0]).toContain('api_keys[0] missing fields');
      expect(e.errors[0]).toContain('salt');
    }
  });

  it('rejects max_concurrent < 1', () => {
    const cfg = { ...validProviderConfig(), max_concurrent: 0 };
    try {
      validateProviderConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors).toContain('max_concurrent must be at least 1');
    }
  });

  it('rejects non-boolean self_priority', () => {
    const cfg = { ...validProviderConfig(), self_priority: 'yes' };
    try {
      validateProviderConfig(cfg);
      expect.unreachable('should throw');
    } catch (err) {
      const e = err as ConfigValidationError;
      expect(e.errors).toContain('self_priority must be a boolean');
    }
  });
});
