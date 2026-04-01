/**
 * Sliding window rate limiter for the Relay server.
 * Tracks timestamps of requests per consumer pubkey.
 */
export class RateLimiter {
  private readonly counts = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number = 60000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /**
   * Attempts to acquire a token for the given pubkey.
   * Returns true if successful, or false and the retry-after delay (in seconds) if rate limited.
   */
  public tryAcquire(pubkey: string): { success: boolean; retryAfter?: number } {
    const now = Date.now();
    let timestamps = this.counts.get(pubkey);

    if (!timestamps) {
      timestamps = [];
      this.counts.set(pubkey, timestamps);
    }

    // Garbage collect expired timestamps
    const cutoff = now - this.windowMs;
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.limit) {
      // Calculate seconds until the oldest timestamp falls out of the window
      const oldest = timestamps[0];
      const timeToFree = (oldest + this.windowMs) - now;
      const retryAfter = Math.max(1, Math.ceil(timeToFree / 1000)); // at least 1 second
      return { success: false, retryAfter };
    }

    timestamps.push(now);
    return { success: true };
  }
}
