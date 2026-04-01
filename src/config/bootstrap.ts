export const OFFICIAL_RELAY_URL = 'wss://relay-jp.runveil.io';
export const DEFAULT_BOOTSTRAP_URL = 'https://bootstrap.runveil.io';
export const RELAY_DISCOVERY_CACHE_TTL_MS = 60_000; // 60s
export const RELAY_DISCOVERY_MAX_RELAYS = 20;

export type RelayDiscoveryMode = 'bootstrap' | 'static' | 'manual';
export const PROTOCOL_VERSION = 1;
export const DEFAULT_GATEWAY_PORT = 9960;
export const DEFAULT_RELAY_PORT = 8080;
export const MAX_REQUEST_AGE_MS = 5 * 60 * 1000; // 5 min
export const PING_INTERVAL_MS = 30_000;
export const PONG_TIMEOUT_MS = 10_000;
export const MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10 MB
export const WS_RECONNECT_BASE_MS = 1000;
export const WS_RECONNECT_MAX_MS = 60_000;

export const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.5,
};

export const MODELS = [
  { id: 'claude-sonnet-4-20250514', created: 1747267200 },
  { id: 'claude-haiku-3-5-20241022', created: 1729555200 },
] as const;

export const MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-20250514': 'claude-sonnet-4-20250514',
  'claude-haiku-3-5-20241022': 'claude-3-5-haiku-20241022',
};
