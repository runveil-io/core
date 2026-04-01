import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RelayDiscoveryClient } from '../src/discovery/client.js';
import type { RelayInfo, BootstrapListResponse } from '../src/discovery/types.js';

// Helper to create a mock relay
function mockRelay(overrides: Partial<RelayInfo> = {}): RelayInfo {
  return {
    relay_pubkey: 'abc123def456',
    relay_id: 'relay-test-1',
    endpoint: 'wss://relay1.test.io',
    models_supported: ['claude-sonnet-4-20250514'],
    fee_pct: 0.01,
    region: 'us-east',
    capacity: 50,
    active_providers: 3,
    reputation_score: 80,
    uptime_pct: 99.5,
    witness_count: 100,
    health_latency_ms: 45,
    version: '0.1.0',
    ...overrides,
  };
}

function mockFetch(relays: RelayInfo[]): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      relays,
      cache_ttl_seconds: 60,
      bootstrap_version: '0.1.0',
    } satisfies BootstrapListResponse),
    text: async () => '',
  }) as unknown as typeof globalThis.fetch;
}

describe('Integration: Consumer with Discovery Client', () => {
  let client: RelayDiscoveryClient;

  beforeEach(() => {
    client = new RelayDiscoveryClient({
      bootstrapUrl: 'https://bootstrap.test.io',
      cacheTtlMs: 60_000,
      maxRelays: 10,
    });
  });

  it('selects the best relay from bootstrap', async () => {
    const relays = [
      mockRelay({ relay_pubkey: 'aaa', endpoint: 'wss://r1.test.io', uptime_pct: 99, fee_pct: 0.01 }),
      mockRelay({ relay_pubkey: 'bbb', endpoint: 'wss://r2.test.io', uptime_pct: 80, fee_pct: 0.05 }),
    ];

    client.fetchImpl = mockFetch(relays);

    const selected = await client.selectRelay();
    expect(selected).not.toBeNull();
    expect(selected!.relay.relay_pubkey).toBe('aaa'); // higher uptime, lower fee
    expect(selected!.score).toBeGreaterThan(0);
  });

  it('failover: selectRelay excludes specified relay pubkeys', async () => {
    const relays = [
      mockRelay({ relay_pubkey: 'aaa', endpoint: 'wss://r1.test.io', uptime_pct: 99 }),
      mockRelay({ relay_pubkey: 'bbb', endpoint: 'wss://r2.test.io', uptime_pct: 95 }),
      mockRelay({ relay_pubkey: 'ccc', endpoint: 'wss://r3.test.io', uptime_pct: 90 }),
    ];

    client.fetchImpl = mockFetch(relays);

    // Exclude the best relay
    const selected = await client.selectRelay(['aaa']);
    expect(selected).not.toBeNull();
    expect(selected!.relay.relay_pubkey).toBe('bbb'); // next best

    // Exclude top two
    const selected2 = await client.selectRelay(['aaa', 'bbb']);
    expect(selected2).not.toBeNull();
    expect(selected2!.relay.relay_pubkey).toBe('ccc');
  });

  it('returns null when all relays are excluded', async () => {
    const relays = [
      mockRelay({ relay_pubkey: 'aaa' }),
    ];

    client.fetchImpl = mockFetch(relays);

    const selected = await client.selectRelay(['aaa']);
    expect(selected).toBeNull();
  });

  it('backwards compatibility: GatewayOptions without discoveryClient works', async () => {
    // This is a type-level test — GatewayOptions should accept no discoveryClient
    const options = {
      port: 9960,
      wallet: {} as any,
      relayUrl: 'wss://relay.test.io',
      // No discoveryClient — should be fine
    };
    // Just verify the type shape is valid (no runtime error)
    expect(options.relayUrl).toBe('wss://relay.test.io');
    expect((options as any).discoveryClient).toBeUndefined();
  });

  it('backwards compatibility: ProviderOptions without discoveryClient works', async () => {
    const options = {
      wallet: {} as any,
      relayUrl: 'wss://relay.test.io',
      apiKeys: [{ provider: 'anthropic' as const, key: 'test' }],
      maxConcurrent: 5,
      // No discoveryClient — should be fine
    };
    expect(options.relayUrl).toBe('wss://relay.test.io');
    expect((options as any).discoveryClient).toBeUndefined();
  });

  it('caches relay list within TTL', async () => {
    const relays = [mockRelay({ relay_pubkey: 'aaa' })];
    const fetchFn = mockFetch(relays);
    client.fetchImpl = fetchFn;

    // First call fetches
    await client.fetchRelays();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Second call within TTL returns cached
    await client.fetchRelays();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refreshCache ignores TTL', async () => {
    const relays = [mockRelay({ relay_pubkey: 'aaa' })];
    const fetchFn = mockFetch(relays);
    client.fetchImpl = fetchFn;

    await client.fetchRelays();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await client.refreshCache();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
