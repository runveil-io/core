/**
 * RelayDiscoveryClient — fetches relay list from Bootstrap, caches locally,
 * scores relays, and selects the best one.
 */

import { createLogger } from '../logger.js';
import type { RelayInfo, RelayScore, DiscoveryConfig, BootstrapListResponse } from './types.js';

const log = createLogger('discovery');

// ---------------------------------------------------------------------------
// Default scoring weights
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS = {
  latency: 0.35,
  fee: 0.25,
  uptime: 0.20,
  reputation: 0.10,
  exploration: 0.10,
};

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function scoreLatency(latencyMs: number | null): number {
  if (latencyMs == null || latencyMs <= 0) return 50; // unknown → neutral
  if (latencyMs <= 50) return 100;
  if (latencyMs >= 500) return 0;
  return Math.max(0, 100 - ((latencyMs - 50) * 100) / 450);
}

function scoreFee(feePct: number): number {
  // 0% → 100, 10%+ → 0
  return Math.max(0, 100 - feePct * 1000);
}

function scoreUptime(uptimePct: number): number {
  return Math.min(100, Math.max(0, uptimePct));
}

function scoreReputation(witnessCount: number): number {
  return Math.min(100, Math.log10(witnessCount + 1) * 33.3);
}

function scoreExploration(witnessCount: number): number {
  if (witnessCount >= 100) return 0;
  return 100 * (1 - witnessCount / 100);
}

function computeRelayScore(
  relay: RelayInfo,
  measuredLatencyMs: number | null,
): RelayScore {
  const latencyMs = measuredLatencyMs ?? relay.health_latency_ms;

  const breakdown = {
    latency: scoreLatency(latencyMs),
    fee: scoreFee(relay.fee_pct),
    uptime: scoreUptime(relay.uptime_pct),
    reputation: scoreReputation(relay.witness_count),
    exploration: scoreExploration(relay.witness_count),
  };

  const score =
    DEFAULT_WEIGHTS.latency * breakdown.latency +
    DEFAULT_WEIGHTS.fee * breakdown.fee +
    DEFAULT_WEIGHTS.uptime * breakdown.uptime +
    DEFAULT_WEIGHTS.reputation * breakdown.reputation +
    DEFAULT_WEIGHTS.exploration * breakdown.exploration;

  return { relay, score, breakdown };
}

// ---------------------------------------------------------------------------
// RelayDiscoveryClient
// ---------------------------------------------------------------------------

interface CacheEntry {
  relays: RelayInfo[];
  fetchedAt: number;
}

export class RelayDiscoveryClient {
  private readonly bootstrapUrl: string;
  private readonly cacheTtlMs: number;
  private readonly maxRelays: number;

  private cache: CacheEntry | null = null;
  private latencyMap: Map<string, number> = new Map();

  /** Optional override for fetch — used in tests. */
  public fetchImpl: typeof globalThis.fetch = globalThis.fetch;

  constructor(config: DiscoveryConfig) {
    this.bootstrapUrl = config.bootstrapUrl.replace(/\/$/, '');
    this.cacheTtlMs = config.cacheTtlMs ?? 60_000;
    this.maxRelays = config.maxRelays ?? 10;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Fetch relay list from Bootstrap (or return cached if within TTL).
   * Optionally filter by region.
   */
  async fetchRelays(region?: string): Promise<RelayInfo[]> {
    const now = Date.now();

    if (this.cache && now - this.cache.fetchedAt < this.cacheTtlMs) {
      log.debug('returning cached relay list', {
        age_ms: now - this.cache.fetchedAt,
        count: this.cache.relays.length,
      });
      const relays = this.cache.relays;
      return region
        ? relays.filter((r) => r.region.startsWith(region))
        : relays;
    }

    const relays = await this.doFetch(region);
    return region
      ? relays.filter((r) => r.region.startsWith(region))
      : relays;
  }

  /**
   * Select the best relay, excluding specific pubkeys.
   * Returns null if no suitable relay is found.
   */
  async selectRelay(exclude?: string[]): Promise<RelayScore | null> {
    const relays = await this.fetchRelays();
    const excludeSet = new Set(exclude ?? []);

    const candidates = relays.filter(
      (r) => !excludeSet.has(r.relay_pubkey) && r.capacity > 0,
    );

    if (candidates.length === 0) return null;

    const scored = candidates
      .map((r) =>
        computeRelayScore(r, this.latencyMap.get(r.relay_pubkey) ?? null),
      )
      .sort((a, b) => b.score - a.score);

    return scored[0];
  }

  /** Force-refresh the cache (ignoring TTL). */
  async refreshCache(): Promise<RelayInfo[]> {
    return this.doFetch();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async doFetch(region?: string): Promise<RelayInfo[]> {
    const url = new URL(`${this.bootstrapUrl}/v1/relays`);
    url.searchParams.set('limit', String(this.maxRelays));
    if (region) url.searchParams.set('region', region);

    log.info('fetching relays from bootstrap', { url: url.toString() });

    const res = await this.fetchImpl(url.toString());
    if (!res.ok) {
      throw new Error(`Bootstrap returned ${res.status}: ${await res.text()}`);
    }

    const data: BootstrapListResponse = await res.json();
    const relays = data.relays;

    // Update cache
    this.cache = { relays, fetchedAt: Date.now() };

    // Measure latency for new relays (WebSocket connect time)
    await this.measureLatencies(relays);

    return relays;
  }

  /**
   * Measure latency to each relay by timing a WebSocket connect.
   * Only measures relays we haven't measured yet.
   */
  private async measureLatencies(relays: RelayInfo[]): Promise<void> {
    const unmeasured = relays.filter(
      (r) => !this.latencyMap.has(r.relay_pubkey),
    );
    if (unmeasured.length === 0) return;

    const results = await Promise.allSettled(
      unmeasured.map(async (r) => {
        const latency = await this.pingRelay(r.endpoint);
        return { pubkey: r.relay_pubkey, latency };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        this.latencyMap.set(result.value.pubkey, result.value.latency);
      }
    }
  }

  /**
   * Ping a relay by measuring WebSocket connect time.
   * Falls back gracefully on error.
   */
  private async pingRelay(endpoint: string): Promise<number> {
    // In Node.js we use the ws package; in environments without WebSocket
    // we fall back to a simple HTTP HEAD to the origin.
    const start = Date.now();

    try {
      // Dynamic import so tests can run without ws
      const { default: WebSocket } = await import('ws');
      return new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(endpoint, { timeout: 5000 });
        ws.on('open', () => {
          const elapsed = Date.now() - start;
          ws.close();
          resolve(elapsed);
        });
        ws.on('error', (err: Error) => {
          ws.close();
          reject(err);
        });
        // Safety timeout
        setTimeout(() => {
          ws.close();
          reject(new Error('ping timeout'));
        }, 5000);
      });
    } catch {
      // If WebSocket is unavailable, return a neutral latency
      return 200;
    }
  }
}

// Re-export scoring for test access
export { computeRelayScore, DEFAULT_WEIGHTS };
