/**
 * Types for Relay Discovery (Phase 1).
 */

/** Relay information returned by Bootstrap API. */
export interface RelayInfo {
  relay_pubkey: string;
  relay_id: string;
  endpoint: string;
  models_supported: string[];
  fee_pct: number;
  region: string;
  capacity: number;
  active_providers: number;
  reputation_score: number;
  uptime_pct: number;
  witness_count: number;
  health_latency_ms: number | null;
  version: string;
}

/** Score breakdown for a single Relay. */
export interface RelayScore {
  relay: RelayInfo;
  score: number;
  breakdown: {
    latency: number;
    fee: number;
    uptime: number;
    reputation: number;
    exploration: number;
  };
}

/** Discovery client configuration. */
export interface DiscoveryConfig {
  bootstrapUrl: string;
  cacheTtlMs?: number;
  maxRelays?: number;
  explorationBonus?: number;
}

/** Bootstrap list response envelope. */
export interface BootstrapListResponse {
  relays: RelayInfo[];
  cache_ttl_seconds: number;
  bootstrap_version: string;
}

/** DB row type for relay_registry table. */
export interface BootstrapRelayEntry {
  relay_pubkey: string;
  relay_id: string;
  endpoint: string;
  models_supported: string;          // JSON-encoded string[]
  fee_pct: number;
  region: string;
  capacity: number;
  version: string;
  active_providers: number;
  active_requests: number;
  uptime_seconds: number;
  registered_at: number;
  last_heartbeat: number;
  last_health_check: number | null;
  health_latency_ms: number | null;
  status: 'online' | 'stale' | 'offline' | 'banned';
  witness_count: number;
  reputation_score: number;
  total_uptime_pct: number;
  ban_reason: string | null;
  ban_until: number | null;
}
