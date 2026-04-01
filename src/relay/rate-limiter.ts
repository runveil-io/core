import { RELAY_RATE_LIMIT } from '../config/index.js';

const DEFAULT_RATE_LIMIT = 60;
const WINDOW_MS = 60_000;

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

export class SlidingWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly store: Map<string, number[]>;
  private readonly cleanupInterval: ReturnType<typeof setInterval>;

  constructor(limit?: number, windowMs?: number) {
    this.limit = limit ?? (RELAY_RATE_LIMIT);
    this.windowMs = windowMs ?? WINDOW_MS;
    this.store = new Map();

    this.cleanupInterval = setInterval(() => this.cleanup(), this.windowMs);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  check(pubkey: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.store.get(pubkey);
    if (!timestamps) {
      timestamps = [];
      this.store.set(pubkey, timestamps);
    }

    // Remove timestamps outside the sliding window
    let i = 0;
    while (i < timestamps.length && timestamps[i] <= windowStart) {
      i++;
    }
    if (i > 0) {
      timestamps.splice(0, i);
    }

    if (timestamps.length >= this.limit) {
      // Oldest timestamp in window: when it expires, a slot opens
      const oldest = timestamps[0];
      const retryAfter = Math.ceil((oldest + this.windowMs - now) / 1000);
      return { allowed: false, retryAfter: Math.max(1, retryAfter) };
    }

    timestamps.push(now);
    return { allowed: true };
  }

  private cleanup(): void {
    const windowStart = Date.now() - this.windowMs;
    for (const [pubkey, timestamps] of this.store.entries()) {
      const filtered = timestamps.filter((t) => t > windowStart);
      if (filtered.length === 0) {
        this.store.delete(pubkey);
      } else {
        this.store.set(pubkey, filtered);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.store.clear();
  }

  injectTimestamps(pubkey: string, timestamps: number[]): void {
    this.store.set(pubkey, [...timestamps]);
  }
  getStore(): ReadonlyMap<string, number[]> {
    return this.store;
  }
}

export function createRateLimiter(limit?: number, windowMs?: number): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(limit, windowMs);
}

