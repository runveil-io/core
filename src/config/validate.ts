/**
 * Config file validation for Veil.
 *
 * Validates config.json and provider.json at startup,
 * reporting all missing/invalid fields at once.
 */

export class ConfigValidationError extends Error {
  constructor(
    public readonly file: string,
    public readonly errors: string[],
  ) {
    const header = `Invalid ${file}:`;
    const body = errors.map((e) => `  - ${e}`).join('\n');
    super(`${header}\n${body}`);
    this.name = 'ConfigValidationError';
  }
}

const HEX_64_RE = /^[0-9a-f]{64}$/;
const WS_URL_RE = /^wss?:\/\/.+/;

// ── config.json ──────────────────────────────────────────────

interface RawConfig {
  relay_url?: unknown;
  gateway_port?: unknown;
  consumer_pubkey?: unknown;
  encryption_pubkey?: unknown;
  [key: string]: unknown;
}

export interface ValidConfig {
  relay_url: string;
  gateway_port: number;
  consumer_pubkey: string;
  encryption_pubkey: string;
}

const CONFIG_REQUIRED_FIELDS = [
  'relay_url',
  'gateway_port',
  'consumer_pubkey',
  'encryption_pubkey',
] as const;

export function validateConfig(raw: unknown): ValidConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigValidationError('config.json', ['File must contain a JSON object']);
  }

  const obj = raw as RawConfig;
  const errors: string[] = [];

  // 1. Check missing required fields (report all at once)
  const missing = CONFIG_REQUIRED_FIELDS.filter((f) => obj[f] === undefined);
  if (missing.length > 0) {
    errors.push(`Missing required fields: ${missing.join(', ')}`);
  }

  // 2. Type & format checks for present fields
  if (obj.relay_url !== undefined) {
    if (typeof obj.relay_url !== 'string') {
      errors.push('relay_url must be a string');
    } else if (!WS_URL_RE.test(obj.relay_url)) {
      errors.push(`relay_url must be a WebSocket URL (ws:// or wss://), got: "${obj.relay_url}"`);
    }
  }

  if (obj.gateway_port !== undefined) {
    if (typeof obj.gateway_port !== 'number' || !Number.isInteger(obj.gateway_port)) {
      errors.push('gateway_port must be an integer');
    } else if (obj.gateway_port < 1 || obj.gateway_port > 65535) {
      errors.push(`gateway_port must be between 1 and 65535, got: ${obj.gateway_port}`);
    }
  }

  if (obj.consumer_pubkey !== undefined) {
    if (typeof obj.consumer_pubkey !== 'string') {
      errors.push('consumer_pubkey must be a string');
    } else if (!HEX_64_RE.test(obj.consumer_pubkey)) {
      errors.push(`consumer_pubkey must be a 64-char hex string (32 bytes), got: "${obj.consumer_pubkey}"`);
    }
  }

  if (obj.encryption_pubkey !== undefined) {
    if (typeof obj.encryption_pubkey !== 'string') {
      errors.push('encryption_pubkey must be a string');
    } else if (!HEX_64_RE.test(obj.encryption_pubkey)) {
      errors.push(`encryption_pubkey must be a 64-char hex string (32 bytes), got: "${obj.encryption_pubkey}"`);
    }
  }

  if (errors.length > 0) {
    throw new ConfigValidationError('config.json', errors);
  }

  return obj as unknown as ValidConfig;
}

// ── provider.json ────────────────────────────────────────────

interface RawProviderConfig {
  version?: unknown;
  models?: unknown;
  api_keys?: unknown;
  max_concurrent?: unknown;
  self_priority?: unknown;
  [key: string]: unknown;
}

export interface ValidProviderConfig {
  version: number;
  models: string[];
  api_keys: Array<{
    provider: string;
    salt: string;
    iv: string;
    ciphertext: string;
    tag: string;
  }>;
  max_concurrent: number;
  self_priority: boolean;
}

const PROVIDER_REQUIRED_FIELDS = [
  'version',
  'models',
  'api_keys',
  'max_concurrent',
] as const;

export function validateProviderConfig(raw: unknown): ValidProviderConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigValidationError('provider.json', ['File must contain a JSON object']);
  }

  const obj = raw as RawProviderConfig;
  const errors: string[] = [];

  // 1. Missing required fields
  const missing = PROVIDER_REQUIRED_FIELDS.filter((f) => obj[f] === undefined);
  if (missing.length > 0) {
    errors.push(`Missing required fields: ${missing.join(', ')}`);
  }

  // 2. Type checks for present fields
  if (obj.version !== undefined) {
    if (typeof obj.version !== 'number' || !Number.isInteger(obj.version)) {
      errors.push('version must be an integer');
    }
  }

  if (obj.models !== undefined) {
    if (!Array.isArray(obj.models)) {
      errors.push('models must be an array');
    } else if (obj.models.length === 0) {
      errors.push('models must contain at least one model');
    } else {
      const bad = obj.models.filter((m: unknown) => typeof m !== 'string');
      if (bad.length > 0) {
        errors.push('models must be an array of strings');
      }
    }
  }

  if (obj.api_keys !== undefined) {
    if (!Array.isArray(obj.api_keys)) {
      errors.push('api_keys must be an array');
    } else if (obj.api_keys.length === 0) {
      errors.push('api_keys must contain at least one entry');
    } else {
      for (let i = 0; i < obj.api_keys.length; i++) {
        const key = obj.api_keys[i] as Record<string, unknown>;
        if (!key || typeof key !== 'object') {
          errors.push(`api_keys[${i}] must be an object`);
          continue;
        }
        const required = ['provider', 'salt', 'iv', 'ciphertext', 'tag'];
        const keyMissing = required.filter((f) => !key[f]);
        if (keyMissing.length > 0) {
          errors.push(`api_keys[${i}] missing fields: ${keyMissing.join(', ')}`);
        }
      }
    }
  }

  if (obj.max_concurrent !== undefined) {
    if (typeof obj.max_concurrent !== 'number' || !Number.isInteger(obj.max_concurrent)) {
      errors.push('max_concurrent must be an integer');
    } else if (obj.max_concurrent < 1) {
      errors.push('max_concurrent must be at least 1');
    }
  }

  if (obj.self_priority !== undefined && typeof obj.self_priority !== 'boolean') {
    errors.push('self_priority must be a boolean');
  }

  if (errors.length > 0) {
    throw new ConfigValidationError('provider.json', errors);
  }

  return obj as unknown as ValidProviderConfig;
}
