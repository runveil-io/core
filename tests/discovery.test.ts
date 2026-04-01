import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RelayDiscoveryClient, computeRelayScore } from '../src/discovery/client.js';
import type { RelayInfo } from '../src/discovery/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRelay(overrides: Partial<RelayInfo> = {}): RelayInfo {
  return {
    relay_pubkey: 'aabb' + Math.random().toString(16).slice(2, 10),
    relay_id: 'aabb1234',
    endpoint: 'wss://relay.example.com',
    models_supported: ['claude-sonnet-4-20250514'],
    fee_pct: 0.05,
    region: 'JP-Tokyo',
    capacity: 10,
    active_providers: 3,
    reputation_score: 50,
    uptime_pct: 99,
    witness_count: 500,
    health_latency_ms: 100,
    version: '0.1.0',
    ...overrides,
  };
}

function mockFetch(relays: RelayInfo[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      relays,
      cache_ttl_seconds: 60,
      bootstrap_version: '0.1.0',
    }),
    text: async () => '',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RelayDiscoveryClient', () => {
  let client: RelayDiscoveryClient;
  const relays = [
    makeRelay({ relay_pubkey: 'relay_a', fee_pct: 0.02, witness_count: 800, health_latency_ms: 50 }),
    makeRelay({ relay_pubkey: 'relay_b', fee_pct: 0.08, witness_count: 50, health_latency_ms: 200 }),
    makeRelay({ relay_pubkey: 'relay_c', fee_pct: 0.05, witness_count: 300, health_latency_ms: 100, capacity: 0 }),
  ];

  beforeEach(() => {
    client = new RelayDiscoveryClient({
      bootstrapUrl: 'http://localhost:9999',
      cacheTtlMs: 1000, // 1 s for fast test
      maxRelays: 10,
    });
    // Override fetch and disable WS pinging
    client.fetchImpl = mockFetch(relays);
  });

  describe('fetchRelays', () => {
    it('fetches from bootstrap on first call', async () => {
      const result = await client.fetchRelays();
      expect(result).toHaveLength(3);
      expect(client.fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('returns cached results within TTL', async () => {
      await client.fetchRelays();
      await client.fetchRelays();
      await client.fetchRelays();
      // Only one actual fetch
      expect(client.fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after TTL expires', async () => {
      client = new RelayDiscoveryClient({
        bootstrapUrl: 'http://localhost:9999',
        cacheTtlMs: 1, // 1 ms TTL
      });
      client.fetchImpl = mockFetch(relays);

      await client.fetchRelays();
      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 10));
      await client.fetchRelays();

      expect(client.fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('filters by region when provided', async () => {
      const mixedRelays = [
        makeRelay({ relay_pubkey: 'jp1', region: 'JP-Tokyo' }),
        makeRelay({ relay_pubkey: 'us1', region: 'US-Virginia' }),
      ];
      client.fetchImpl = mockFetch(mixedRelays);

      const result = await client.fetchRelays('JP');
      expect(result).toHaveLength(1);
      expect(result[0].region).toBe('JP-Tokyo');
    });
  });

  describe('selectRelay', () => {
    it('picks highest scored relay', async () => {
      const result = await client.selectRelay();
      expect(result).not.toBeNull();
      // relay_a has lowest fee + lowest latency + high witness count → should score highest
      expect(result!.relay.relay_pubkey).toBe('relay_a');
      expect(result!.score).toBeGreaterThan(0);
    });

    it('excludes specified pubkeys', async () => {
      const result = await client.selectRelay(['relay_a']);
      expect(result).not.toBeNull();
      // relay_c has capacity 0 so it's filtered, leaving only relay_b
      expect(result!.relay.relay_pubkey).toBe('relay_b');
    });

    it('returns null when all relays are excluded or have zero capacity', async () => {
      const result = await client.selectRelay(['relay_a', 'relay_b']);
      // relay_c has capacity 0 → also filtered
      expect(result).toBeNull();
    });

    it('filters out zero-capacity relays', async () => {
      const zeroCapRelays = [
        makeRelay({ relay_pubkey: 'r1', capacity: 0 }),
      ];
      client.fetchImpl = mockFetch(zeroCapRelays);
      client = new RelayDiscoveryClient({ bootstrapUrl: 'http://localhost:9999' });
      client.fetchImpl = mockFetch(zeroCapRelays);

      const result = await client.selectRelay();
      expect(result).toBeNull();
    });
  });

  describe('refreshCache', () => {
    it('forces a new fetch regardless of TTL', async () => {
      await client.fetchRelays();
      expect(client.fetchImpl).toHaveBeenCalledTimes(1);

      await client.refreshCache();
      expect(client.fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});

describe('computeRelayScore', () => {
  it('scores a relay with low latency and low fee highly', () => {
    const relay = makeRelay({
      fee_pct: 0.01,
      uptime_pct: 99.5,
      witness_count: 1000,
      health_latency_ms: 30,
    });

    const result = computeRelayScore(relay, 30);
    expect(result.score).toBeGreaterThan(80);
    expect(result.breakdown.latency).toBe(100); // ≤50ms → 100
    expect(result.breakdown.fee).toBe(90);       // 1% → 90
    expect(result.breakdown.exploration).toBe(0); // witness ≥100 → 0
  });

  it('gives exploration bonus to new relays', () => {
    const newRelay = makeRelay({ witness_count: 10 });
    const oldRelay = makeRelay({ witness_count: 500 });

    const newScore = computeRelayScore(newRelay, 100);
    const oldScore = computeRelayScore(oldRelay, 100);

    expect(newScore.breakdown.exploration).toBe(90); // (1 - 10/100) * 100
    expect(oldScore.breakdown.exploration).toBe(0);
  });

  it('uses health_latency_ms when no measured latency', () => {
    const relay = makeRelay({ health_latency_ms: 200 });
    const result = computeRelayScore(relay, null);
    // 200ms → ~66.7 score
    expect(result.breakdown.latency).toBeCloseTo(66.67, 0);
  });

  it('gives 0 latency score for very high latency', () => {
    const relay = makeRelay({ health_latency_ms: 600 });
    const result = computeRelayScore(relay, null);
    expect(result.breakdown.latency).toBe(0);
  });
});
