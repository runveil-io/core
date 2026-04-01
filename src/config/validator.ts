import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ConfigValidationError {
  field: string;
  message: string;
}

export class ConfigValidationResult {
  public readonly errors: ConfigValidationError[];

  constructor(errors: ConfigValidationError[]) {
    this.errors = errors;
  }

  get valid(): boolean {
    return this.errors.length === 0;
  }

  format(): string {
    if (this.valid) return 'Config is valid.';
    const lines = this.errors.map(
      (e) => `  • ${e.field}: ${e.message}`
    );
    return `Config validation failed:\n${lines.join('\n')}`;
  }
}

const HEX_RE = /^[0-9a-fA-F]+$/;
const WSS_RE = /^wss?:\/\/.+/;

function isHexString(value: unknown, expectedLength?: number): boolean {
  if (typeof value !== 'string') return false;
  if (!HEX_RE.test(value)) return false;
  if (expectedLength !== undefined && value.length !== expectedLength) return false;
  return true;
}

export function validateConfig(raw: unknown): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];

  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return new ConfigValidationResult([
      { field: 'config', message: 'Config must be a JSON object.' },
    ]);
  }

  const config = raw as Record<string, unknown>;

  // relay_url — required, must be ws:// or wss://
  if (!('relay_url' in config) || config.relay_url === undefined) {
    errors.push({ field: 'relay_url', message: 'Required field is missing.' });
  } else if (typeof config.relay_url !== 'string') {
    errors.push({ field: 'relay_url', message: 'Must be a string.' });
  } else if (!WSS_RE.test(config.relay_url)) {
    errors.push({ field: 'relay_url', message: 'Must start with ws:// or wss://.' });
  }

  // gateway_port — required, must be a positive integer 1-65535
  if (!('gateway_port' in config) || config.gateway_port === undefined) {
    errors.push({ field: 'gateway_port', message: 'Required field is missing.' });
  } else if (typeof config.gateway_port !== 'number' || !Number.isInteger(config.gateway_port)) {
    errors.push({ field: 'gateway_port', message: 'Must be an integer.' });
  } else if (config.gateway_port < 1 || config.gateway_port > 65535) {
    errors.push({ field: 'gateway_port', message: 'Must be between 1 and 65535.' });
  }

  // consumer_pubkey — required, hex string (64 chars for ed25519)
  if (!('consumer_pubkey' in config) || config.consumer_pubkey === undefined) {
    errors.push({ field: 'consumer_pubkey', message: 'Required field is missing.' });
  } else if (typeof config.consumer_pubkey !== 'string') {
    errors.push({ field: 'consumer_pubkey', message: 'Must be a hex string.' });
  } else if (!HEX_RE.test(config.consumer_pubkey)) {
    errors.push({ field: 'consumer_pubkey', message: 'Must be a valid hex string.' });
  } else if (config.consumer_pubkey.length !== 64) {
    errors.push({ field: 'consumer_pubkey', message: 'Must be 64 hex characters (32-byte key).' });
  }

  // encryption_pubkey — required, hex string (64 chars for x25519)
  if (!('encryption_pubkey' in config) || config.encryption_pubkey === undefined) {
    errors.push({ field: 'encryption_pubkey', message: 'Required field is missing.' });
  } else if (typeof config.encryption_pubkey !== 'string') {
    errors.push({ field: 'encryption_pubkey', message: 'Must be a hex string.' });
  } else if (!HEX_RE.test(config.encryption_pubkey)) {
    errors.push({ field: 'encryption_pubkey', message: 'Must be a valid hex string.' });
  } else if (config.encryption_pubkey.length !== 64) {
    errors.push({ field: 'encryption_pubkey', message: 'Must be 64 hex characters (32-byte key).' });
  }

  return new ConfigValidationResult(errors);
}

export function validateProviderConfig(raw: unknown): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];

  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return new ConfigValidationResult([
      { field: 'provider_config', message: 'Provider config must be a JSON object.' },
    ]);
  }

  const config = raw as Record<string, unknown>;

  // version — required, must be 1
  if (!('version' in config) || config.version === undefined) {
    errors.push({ field: 'version', message: 'Required field is missing.' });
  } else if (config.version !== 1) {
    errors.push({ field: 'version', message: 'Must be 1.' });
  }

  // models — required, non-empty array of strings
  if (!('models' in config) || config.models === undefined) {
    errors.push({ field: 'models', message: 'Required field is missing.' });
  } else if (!Array.isArray(config.models)) {
    errors.push({ field: 'models', message: 'Must be an array.' });
  } else if (config.models.length === 0) {
    errors.push({ field: 'models', message: 'Must contain at least one model.' });
  } else if (!config.models.every((m: unknown) => typeof m === 'string')) {
    errors.push({ field: 'models', message: 'All entries must be strings.' });
  }

  // api_keys — required, non-empty array
  if (!('api_keys' in config) || config.api_keys === undefined) {
    errors.push({ field: 'api_keys', message: 'Required field is missing.' });
  } else if (!Array.isArray(config.api_keys)) {
    errors.push({ field: 'api_keys', message: 'Must be an array.' });
  } else if (config.api_keys.length === 0) {
    errors.push({ field: 'api_keys', message: 'Must contain at least one API key entry.' });
  }

  // max_concurrent — optional, positive integer
  if ('max_concurrent' in config && config.max_concurrent !== undefined) {
    if (typeof config.max_concurrent !== 'number' || !Number.isInteger(config.max_concurrent)) {
      errors.push({ field: 'max_concurrent', message: 'Must be an integer.' });
    } else if (config.max_concurrent < 1) {
      errors.push({ field: 'max_concurrent', message: 'Must be at least 1.' });
    }
  }

  return new ConfigValidationResult(errors);
}

export function validateWalletFile(raw: unknown): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];

  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return new ConfigValidationResult([
      { field: 'wallet', message: 'Wallet file must be a JSON object.' },
    ]);
  }

  const file = raw as Record<string, unknown>;

  if (file.version !== 1) {
    errors.push({ field: 'version', message: 'Must be 1.' });
  }

  if (file.kdf !== 'scrypt') {
    errors.push({ field: 'kdf', message: "Must be 'scrypt'." });
  }

  for (const hexField of ['salt', 'iv', 'ciphertext', 'tag'] as const) {
    if (!(hexField in file) || typeof file[hexField] !== 'string') {
      errors.push({ field: hexField, message: 'Required hex field is missing.' });
    } else if (!HEX_RE.test(file[hexField] as string)) {
      errors.push({ field: hexField, message: 'Must be a valid hex string.' });
    }
  }

  if (!('kdf_params' in file) || typeof file.kdf_params !== 'object' || file.kdf_params === null) {
    errors.push({ field: 'kdf_params', message: 'Required object field is missing.' });
  } else {
    const kdf = file.kdf_params as Record<string, unknown>;
    for (const p of ['N', 'r', 'p'] as const) {
      if (typeof kdf[p] !== 'number' || !Number.isInteger(kdf[p] as number)) {
        errors.push({ field: `kdf_params.${p}`, message: 'Must be an integer.' });
      }
    }
  }

  return new ConfigValidationResult(errors);
}

/**
 * Loads and validates config.json from the veil home directory.
 * Throws with a clear, formatted error listing all bad fields.
 */
export function loadAndValidateConfig(veilHome: string): Record<string, unknown> {
  const configPath = join(veilHome, 'config.json');

  if (!existsSync(configPath)) {
    throw new Error("Config file not found. Run 'veil init' first.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    throw new Error(`config.json is not valid JSON.`);
  }

  const result = validateConfig(raw);
  if (!result.valid) {
    throw new Error(result.format());
  }

  return raw as Record<string, unknown>;
}

/**
 * Loads and validates provider.json from the veil home directory.
 * Throws with a clear, formatted error listing all bad fields.
 */
export function loadAndValidateProviderConfig(veilHome: string): Record<string, unknown> {
  const providerPath = join(veilHome, 'provider.json');

  if (!existsSync(providerPath)) {
    throw new Error("Provider config not found. Run 'veil provide init' first.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(providerPath, 'utf-8'));
  } catch {
    throw new Error(`provider.json is not valid JSON.`);
  }

  const result = validateProviderConfig(raw);
  if (!result.valid) {
    throw new Error(result.format());
  }

  return raw as Record<string, unknown>;
}
