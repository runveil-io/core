import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../src/relay/rate_limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests up to the limit', () => {
    const limiter = new RateLimiter(5, 60000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryAcquire('user1').success).toBe(true);
    }
  });

  it('blocks requests over the limit and reports retryAfter', () => {
    const limiter = new RateLimiter(2, 60000);
    expect(limiter.tryAcquire('user1').success).toBe(true);
    expect(limiter.tryAcquire('user1').success).toBe(true);
    
    const result = limiter.tryAcquire('user1');
    expect(result.success).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter).toBeLessThanOrEqual(60);
  });

  it('keeps separate counts per pubkey', () => {
    const limiter = new RateLimiter(1, 60000);
    expect(limiter.tryAcquire('user1').success).toBe(true);
    expect(limiter.tryAcquire('user2').success).toBe(true);
    expect(limiter.tryAcquire('user1').success).toBe(false);
  });

  it('resets sliding window and garbage collects', () => {
    const limiter = new RateLimiter(2, 10000); // 10s window
    
    expect(limiter.tryAcquire('user1').success).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(limiter.tryAcquire('user1').success).toBe(true);
    
    // Now blocked
    expect(limiter.tryAcquire('user1').success).toBe(false);
    
    // Advance 5.1s, the first request is >10s old and garbage collected
    vi.advanceTimersByTime(5100);
    expect(limiter.tryAcquire('user1').success).toBe(true);
    
    // But only one slot freed up, fully blocked again
    expect(limiter.tryAcquire('user1').success).toBe(false);
  });
});
