import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderSelector } from '../src/consumer/selector.js';
import type { ProviderInfo, ProviderMetrics, SelectionCriteria } from '../src/types.js';

function makeProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    pubkey: `pk_${Math.random().toString(36).slice(2)}`,
    models: ['claude-sonnet-4-20250514'],
    endpoint: 'wss://relay.example.com',
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<ProviderMetrics> = {}): ProviderMetrics {
  return {
    latencyMs: 100,
    capacityScore: 1.0,
    errorRate: 0,
    lastSeen: Date.now(),
    successCount: 10,
    failureCount: 0,
    circuitState: 'closed',
    ...overrides,
  };
}

describe('ProviderSelector', () => {
  let providers: ProviderInfo[];
  let selector: ProviderSelector;

  beforeEach(() => {
    providers = [
      makeProvider({ pubkey: 'pk_a', models: ['claude-sonnet-4-20250514', 'claude-opus-4-5'] }),
      makeProvider({ pubkey: 'pk_b', models: ['claude-sonnet-4-20250514'] }),
      makeProvider({ pubkey: 'pk_c', models: ['claude-opus-4-5'] }),
    ];
    selector = new ProviderSelector(providers);
  });

  describe('selectProvider()', () => {
    it('returns null when no providers are available', () => {
      const empty = new ProviderSelector([]);
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      expect(empty.selectProvider(criteria)).toBeNull();
    });

    it('returns a provider that supports the requested model', () => {
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      const result = selector.selectProvider(criteria);
      expect(result).not.toBeNull();
      expect(result!.models).toContain('claude-sonnet-4-20250514');
    });

    it('returns null when no provider supports the requested model', () => {
      const criteria: SelectionCriteria = { model: 'gpt-4' };
      const result = selector.selectProvider(criteria);
      expect(result).toBeNull();
    });

    it('filters providers by model correctly', () => {
      const criteria: SelectionCriteria = { model: 'claude-opus-4-5' };
      const result = selector.selectProvider(criteria);
      expect(result).not.toBeNull();
      expect(result!.models).toContain('claude-opus-4-5');
    });

    it('selects the provider with the lowest latency when metrics are provided', () => {
      const metricsMap = new Map<string, ProviderMetrics>([
        ['pk_a', makeMetrics({ latencyMs: 300 })],
        ['pk_b', makeMetrics({ latencyMs: 50 })],
      ]);
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      const result = selector.selectProvider(criteria, metricsMap);
      expect(result).not.toBeNull();
      expect(result!.pubkey).toBe('pk_b');
    });

    it('selects the provider with the highest capacity when latency is equal', () => {
      const metricsMap = new Map<string, ProviderMetrics>([
        ['pk_a', makeMetrics({ latencyMs: 100, capacityScore: 0.3 })],
        ['pk_b', makeMetrics({ latencyMs: 100, capacityScore: 0.9 })],
      ]);
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      const result = selector.selectProvider(criteria, metricsMap);
      expect(result).not.toBeNull();
      expect(result!.pubkey).toBe('pk_b');
    });

    it('skips providers with open circuit breaker', () => {
      const metricsMap = new Map<string, ProviderMetrics>([
        ['pk_a', makeMetrics({ latencyMs: 50, circuitState: 'open' })],
        ['pk_b', makeMetrics({ latencyMs: 200, circuitState: 'closed' })],
      ]);
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      const result = selector.selectProvider(criteria, metricsMap);
      expect(result).not.toBeNull();
      expect(result!.pubkey).toBe('pk_b');
    });

    it('skips providers with half-open circuit breaker unless no alternatives exist', () => {
      const metricsMap = new Map<string, ProviderMetrics>([
        ['pk_a', makeMetrics({ latencyMs: 50, circuitState: 'half-open' })],
        ['pk_b', makeMetrics({ latencyMs: 200, circuitState: 'closed' })],
      ]);
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      const result = selector.selectProvider(criteria, metricsMap);
      expect(result).not.toBeNull();
      expect(result!.pubkey).toBe('pk_b');
    });

    it('falls back to half-open provider when no closed circuit providers are available', () => {
      const singleProvider = [makeProvider({ pubkey: 'pk_a', models: ['claude-sonnet-4-20250514'] })];
      const s = new ProviderSelector(singleProvider);
      const metricsMap = new Map<string, ProviderMetrics>([
        ['pk_a', makeMetrics({ circuitState: 'half-open' })],
      ]);
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      const result = s.selectProvider(criteria, metricsMap);
      expect(result).not.toBeNull();
      expect(result!.pubkey).toBe('pk_a');
    });

    it('respects maxLatencyMs criterion and excludes slow providers', () => {
      const metricsMap = new Map<string, ProviderMetrics>([
        ['pk_a', makeMetrics({ latencyMs: 500 })],
        ['pk_b', makeMetrics({ latencyMs: 80 })],
      ]);
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514', maxLatencyMs: 200 };
      const result = selector.selectProvider(criteria, metricsMap);
      expect(result).not.toBeNull();
      expect(result!.pubkey).toBe('pk_b');
    });

    it('respects minCapacityScore criterion and excludes low-capacity providers', () => {
      const metricsMap = new Map<string, ProviderMetrics>([
        ['pk_a', makeMetrics({ capacityScore: 0.1 })],
        ['pk_b', makeMetrics({ capacityScore: 0.8 })],
      ]);
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514', minCapacityScore: 0.5 };
      const result = selector.selectProvider(criteria, metricsMap);
      expect(result).not.toBeNull();
      expect(result!.pubkey).toBe('pk_b');
    });

    it('is deterministic with the same seed', () => {
      const manyProviders = Array.from({ length: 5 }, (_, i) =>
        makeProvider({ pubkey: `pk_${i}`, models: ['claude-sonnet-4-20250514'] }),
      );
      const s1 = new ProviderSelector(manyProviders, { seed: 42 });
      const s2 = new ProviderSelector(manyProviders, { seed: 42 });
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      const r1 = s1.selectProvider(criteria);
      const r2 = s2.selectProvider(criteria);
      expect(r1!.pubkey).toBe(r2!.pubkey);
    });

    it('produces different results with different seeds when providers have equal scores', () => {
      const manyProviders = Array.from({ length: 10 }, (_, i) =>
        makeProvider({ pubkey: `pk_${i}`, models: ['claude-sonnet-4-20250514'] }),
      );
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      const results = new Set<string>();
      for (let seed = 0; seed < 20; seed++) {
        const s = new ProviderSelector(manyProviders, { seed });
        const r = s.selectProvider(criteria);
        if (r) results.add(r.pubkey);
      }
      expect(results.size).toBeGreaterThan(1);
    });
  });

  describe('markProviderFailed()', () => {
    it('excludes a failed provider from subsequent selections', () => {
      const twoProviders = [
        makeProvider({ pubkey: 'pk_a', models: ['claude-sonnet-4-20250514'] }),
        makeProvider({ pubkey: 'pk_b', models: ['claude-sonnet-4-20250514'] }),
      ];
      const s = new ProviderSelector(twoProviders);
      s.markProviderFailed('pk_a');
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      for (let i = 0; i < 10; i++) {
        const result = s.selectProvider(criteria);
        expect(result!.pubkey).toBe('pk_b');
      }
    });

    it('returns null when all providers are marked as failed', () => {
      selector.markProviderFailed('pk_a');
      selector.markProviderFailed('pk_b');
      selector.markProviderFailed('pk_c');
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      expect(selector.selectProvider(criteria)).toBeNull();
    });

    it('increments failure count on repeated calls', () => {
      selector.markProviderFailed('pk_a');
      selector.markProviderFailed('pk_a');
      selector.markProviderFailed('pk_a');
      const state = selector.getProviderState('pk_a');
      expect(state!.failureCount).toBeGreaterThanOrEqual(3);
    });

    it('opens the circuit breaker after threshold failures', () => {
      for (let i = 0; i < 5; i++) {
        selector.markProviderFailed('pk_a');
      }
      const state = selector.getProviderState('pk_a');
      expect(state!.circuitState).toBe('open');
    });

    it('records the error type when provided', () => {
      selector.markProviderFailed('pk_a', 'timeout');
      const state = selector.getProviderState('pk_a');
      expect(state!.lastErrorType).toBe('timeout');
    });
  });

  describe('markProviderSuccess()', () => {
    it('resets failure count on success', () => {
      selector.markProviderFailed('pk_a');
      selector.markProviderFailed('pk_a');
      selector.markProviderSuccess('pk_a');
      const state = selector.getProviderState('pk_a');
      expect(state!.failureCount).toBe(0);
    });

    it('closes a half-open circuit on success', () => {
      const s = new ProviderSelector(providers, { circuitBreakerThreshold: 2 });
      s.markProviderFailed('pk_a');
      s.markProviderFailed('pk_a');
      // Manually transition to half-open for test
      s.setCircuitState('pk_a', 'half-open');
      s.markProviderSuccess('pk_a');
      const state = s.getProviderState('pk_a');
      expect(state!.circuitState).toBe('closed');
    });
  });

  describe('resetFailedProviders()', () => {
    it('makes previously failed providers available again', () => {
      const twoProviders = [
        makeProvider({ pubkey: 'pk_a', models: ['claude-sonnet-4-20250514'] }),
        makeProvider({ pubkey: 'pk_b', models: ['claude-sonnet-4-20250514'] }),
      ];
      const s = new ProviderSelector(twoProviders);
      s.markProviderFailed('pk_a');
      s.markProviderFailed('pk_b');
      s.resetFailedProviders();
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      const result = s.selectProvider(criteria);
      expect(result).not.toBeNull();
    });

    it('resets all circuit breaker states to closed', () => {
      for (let i = 0; i < 10; i++) {
        selector.markProviderFailed('pk_a');
      }
      selector.resetFailedProviders();
      const state = selector.getProviderState('pk_a');
      expect(state!.circuitState).toBe('closed');
      expect(state!.failureCount).toBe(0);
    });

    it('resets only providers older than the given ttl', () => {
      const s = new ProviderSelector(providers);
      s.markProviderFailed('pk_a');
      // pk_b was failed much earlier (simulate by manipulating internal state)
      s.markProviderFailed('pk_b');
      s.setFailedAt('pk_b', Date.now() - 60_000);
      s.resetFailedProviders({ olderThanMs: 30_000 });
      const stateA = s.getProviderState('pk_a');
      const stateB = s.getProviderState('pk_b');
      // pk_a was failed recently, should remain failed (if it crossed threshold)
      // pk_b was failed long ago, should be reset
      expect(stateB!.failureCount).toBe(0);
      expect(stateB!.circuitState).toBe('closed');
      // pk_a should not have been reset
      expect(stateA!.failureCount).toBeGreaterThan(0);
    });
  });

  describe('getFallbackQueue()', () => {
    it('returns providers in order of preference for a given model', () => {
      const metricsMap = new Map<string, ProviderMetrics>([
        ['pk_a', makeMetrics({ latencyMs: 200, capacityScore: 0.5 })],
        ['pk_b', makeMetrics({ latencyMs: 50, capacityScore: 0.9 })],
      ]);
      const criteria: SelectionCriteria = { model: 'claude-sonnet-4-20250514' };
      const queue = selector.getFallbackQueue(criteria, metricsMap);
      expect(queue.length).toBeGreaterThanOrEqual(2);
      expect(queue[0].pubkey).toBe('pk_b');
    });

    it('excludes providers with open circuit', () => {
      const metricsMap = new Map<string, ProviderMetrics>([
        ['pk_a', makeMetrics({ circuitState: 'open' })],
        ['pk_b', makeMetrics({ circuitState: 'closed' })],
      ]);
      const criteria: SelectionCrit