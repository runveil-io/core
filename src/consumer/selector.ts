import { createLogger } from '../logger.js';
import type { ProviderInfo, ProviderMetrics, SelectionCriteria } from '../types.js';

const log = createLogger('consumer:selector');

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface ProviderCircuit {
  state: CircuitState;
  failures: number;
  lastFailure: number;
  lastSuccess: number;
  halfOpenAttempts: number;
}

export interface ScoredProvider {
  provider: ProviderInfo;
  score: number;
  metrics: ProviderMetrics;
}

const CIRCUIT_OPEN_DURATION_MS = 60_000;
const CIRCUIT_HALF_OPEN_MAX_ATTEMPTS = 1;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_LATENCY = 1000;
const DEFAULT_CAPACITY = 1.0;

function seedRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return ((s >>> 0) / 0xffffffff);
  };
}

export class ProviderSelector {
  private providers: ProviderInfo[] = [];
  private metrics: Map<string, ProviderMetrics> = new Map();
  private circuits: Map<string, ProviderCircuit> = new Map();
  private failedAt: Map<string, number> = new Map();
  private resetInterval: ReturnType<typeof setInterval> | null = null;
  private rng: () => number;

  constructor(
    providers: ProviderInfo[] = [],
    private readonly resetIntervalMs: number = 300_000,
    seed?: number,
  ) {
    this.rng = seed !== undefined ? seedRandom(seed) : Math.random.bind(Math);
    this.setProviders(providers);
    this.startResetTimer();
  }

  setProviders(providers: ProviderInfo[]): void {
    this.providers = [...providers];
    for (const p of providers) {
      if (!this.metrics.has(p.pubkey)) {
        this.metrics.set(p.pubkey, {
          pubkey: p.pubkey,
          latencyMs: DEFAULT_LATENCY,
          capacity: DEFAULT_CAPACITY,
          successCount: 0,
          failureCount: 0,
          lastUpdated: Date.now(),
        });
      }
      if (!this.circuits.has(p.pubkey)) {
        this.circuits.set(p.pubkey, {
          state: 'closed',
          failures: 0,
          lastFailure: 0,
          lastSuccess: 0,
          halfOpenAttempts: 0,
        });
      }
    }
  }

  updateMetrics(pubkey: string, update: Partial<Pick<ProviderMetrics, 'latencyMs' | 'capacity'>>): void {
    const existing = this.metrics.get(pubkey);
    if (!existing) return;
    this.metrics.set(pubkey, {
      ...existing,
      ...update,
      lastUpdated: Date.now(),
    });
  }

  selectProvider(criteria?: SelectionCriteria): ProviderInfo | null {
    const available = this.getAvailableProviders(criteria);
    if (available.length === 0) {
      log.warn('No available providers after filtering');
      return null;
    }

    const scored = this.scoreProviders(available, criteria);
    scored.sort((a, b) => b.score - a.score);

    const top = scored[0];
    const circuit = this.circuits.get(top.provider.pubkey);
    if (circuit && circuit.state === 'half-open') {
      circuit.halfOpenAttempts++;
    }

    log.info({ pubkey: top.provider.pubkey, score: top.score }, 'Selected provider');
    return top.provider;
  }

  markProviderFailed(pubkey: string): void {
    const now = Date.now();
    this.failedAt.set(pubkey, now);

    const circuit = this.circuits.get(pubkey);
    if (!circuit) return;

    circuit.failures++;
    circuit.lastFailure = now;

    const metrics = this.metrics.get(pubkey);
    if (metrics) {
      metrics.failureCount++;
      metrics.lastUpdated = now;
    }

    if (circuit.state === 'half-open') {
      circuit.state = 'open';
      circuit.halfOpenAttempts = 0;
      log.warn({ pubkey }, 'Circuit breaker: half-open → open (failure in probe)');
      return;
    }

    if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD) {
      circuit.state = 'open';
      log.warn({ pubkey, failures: circuit.failures }, 'Circuit breaker: closed → open');
    }
  }

  markProviderSuccess(pubkey: string, latencyMs?: number): void {
    const now = Date.now();
    this.failedAt.delete(pubkey);

    const circuit = this.circuits.get(pubkey);
    if (circuit) {
      if (circuit.state === 'half-open') {
        circuit.state = 'closed';
        circuit.failures = 0;
        circuit.halfOpenAttempts = 0;
        log.info({ pubkey }, 'Circuit breaker: half-open → closed (success)');
      }
      circuit.lastSuccess = now;
    }

    const metrics = this.metrics.get(pubkey);
    if (metrics) {
      metrics.successCount++;
      metrics.lastUpdated = now;
      if (latencyMs !== undefined) {
        metrics.latencyMs = metrics.latencyMs * 0.7 + latencyMs * 0.3;
      }
    }
  }

  resetFailedProviders(): void {
    const now = Date.now();
    let resetCount = 0;

    for (const [pubkey, circuit] of this.circuits.entries()) {
      if (circuit.state === 'open') {
        const elapsed = now - circuit.lastFailure;
        if (elapsed >= CIRCUIT_OPEN_DURATION_MS) {
          circuit.state = 'half-open';
          circuit.halfOpenAttempts = 0;
          resetCount++;
          log.info({ pubkey, elapsedMs: elapsed }, 'Circuit breaker: open → half-open (reset)');
        }
      }
    }

    if (resetCount > 0) {
      log.info({ resetCount }, 'Reset failed providers to half-open');
    }
  }

  forceResetAllProviders(): void {
    for (const [pubkey, circuit] of this.circuits.entries()) {
      circuit.state = 'closed';
      circuit.failures = 0;
      circuit.halfOpenAttempts = 0;
      this.failedAt.delete(pubkey);
      log.info({ pubkey }, 'Force reset provider circuit');
    }
  }

  getCircuitState(pubkey: string): CircuitState | null {
    return this.circuits.get(pubkey)?.state ?? null;
  }

  getMetrics(pubkey: string): ProviderMetrics | null {
    return this.metrics.get(pubkey) ?? null;
  }

  getAllMetrics(): ProviderMetrics[] {
    return Array.from(this.metrics.values());
  }

  getAvailableCount(): number {
    return this.getAvailableProviders().length;
  }

  destroy(): void {
    if (this.resetInterval) {
      clearInterval(this.resetInterval);
      this.resetInterval = null;
    }
  }

  private getAvailableProviders(criteria?: SelectionCriteria): ProviderInfo[] {
    const now = Date.now();

    return this.providers.filter((p) => {
      const circuit = this.circuits.get(p.pubkey);
      if (!circuit) return false;

      if (circuit.state === 'open') {
        const elapsed = now - circuit.lastFailure;
        if (elapsed >= CIRCUIT_OPEN_DURATION_MS) {
          circuit.state = 'half-open';
          circuit.halfOpenAttempts = 0;
          log.info({ pubkey: p.pubkey }, 'Circuit auto-transitioned open → half-open');
        } else {
          return false;
        }
      }

      if (circuit.state === 'half-open' && circuit.halfOpenAttempts >= CIRCUIT_HALF_OPEN_MAX_ATTEMPTS) {
        return false;
      }

      if (criteria?.requiredModel) {
        const hasModel = p.models?.includes(criteria.requiredModel) ?? false;
        if (!hasModel) return false;
      }

      if (criteria?.minCapacity !== undefined) {
        const metrics = this.metrics.get(p.pubkey);
        const capacity = metrics?.capacity ?? DEFAULT_CAPACITY;
        if (capacity < criteria.minCapacity) return false;
      }

      if (criteria?.maxLatencyMs !== undefined) {
        const metrics = this.metrics.get(p.pubkey);
        const latency = metrics?.latencyMs ?? DEFAULT_LATENCY;
        if (latency > criteria.maxLatencyMs) return false;
      }

      return true;
    });
  }

  private scoreProviders(providers: ProviderInfo[], criteria?: SelectionCriteria): ScoredProvider[] {
    const weightLatency = criteria?.weightLatency ?? 0.4;
    const weightCapacity = criteria?.weightCapacity ?? 0.4;
    const weightRandom = criteria?.weightRandom ?? 0.2;

    const allMetrics = providers.map((p) => this.metrics.get(p.pubkey)!);
    const latencies = allMetrics.map((m) => m?.latencyMs ?? DEFAULT_LATENCY);
    const capacities = allMetrics.map((m) => m?.capacity ?? DEFAULT_CAPACITY);

    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    const latencyRange = maxLatency - minLatency || 1;

    const minCapacity = Math.min(...capacities);
    const maxCapacity = Math.max(...capacities);
    const capacityRange = maxCapacity - minCapacity || 1;

    return providers.map((p, i) => {
      const m = allMetrics[i] ?? { latencyMs: DEFAULT_LATENCY, capacity: DEFAULT_CAPACITY };

      const latencyScore = 1 - (m.latencyMs - minLatency) / latencyRange;
      const capacityScore = (m.capacity - minCapacity) / capacityRange;
      const randomScore = this.rng();

      const score =
        weightLatency * latencyScore +
        weightCapacity * capacityScore +
        weightRandom * randomScore;

      return { provider: p, score, metrics: m as ProviderMetrics };
    });
  }

  private startResetTimer(): void {
    if (this.resetIntervalMs <= 0) return;
    this.resetInterval = setInterval(() => {
      this.resetFailedProviders();
    }, this.resetIntervalMs);
    if (this.resetInterval.unref) {
      this.resetInterval.unref();
    }
  }
}