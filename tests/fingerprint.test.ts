import {
  randomizeVersion,
  randomizeUserAgent,
  randomJitterMs,
  randomizeMaxTokens,
  _resetState,
  _pools,
} from '../src/provider/fingerprint';

beforeEach(() => {
  _resetState();
});

describe('randomizeVersion', () => {
  it('returns a value from the ANTHROPIC_VERSIONS pool', () => {
    for (let i = 0; i < 50; i++) {
      expect(_pools.ANTHROPIC_VERSIONS).toContain(randomizeVersion());
    }
  });

  it('never returns the same value on consecutive calls', () => {
    for (let i = 0; i < 100; i++) {
      const a = randomizeVersion();
      const b = randomizeVersion();
      expect(a).not.toBe(b);
    }
  });

  it('covers multiple versions over many calls (distribution)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(randomizeVersion());
    }
    // Should hit at least 3 distinct versions
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});

describe('randomizeUserAgent', () => {
  it('returns a value from the USER_AGENTS pool', () => {
    for (let i = 0; i < 50; i++) {
      expect(_pools.USER_AGENTS).toContain(randomizeUserAgent());
    }
  });

  it('never returns the same value on consecutive calls', () => {
    for (let i = 0; i < 100; i++) {
      const a = randomizeUserAgent();
      const b = randomizeUserAgent();
      expect(a).not.toBe(b);
    }
  });

  it('covers multiple user agents over many calls (distribution)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(randomizeUserAgent());
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});

describe('randomJitterMs', () => {
  it('returns values in [0, 500]', () => {
    for (let i = 0; i < 500; i++) {
      const jitter = randomJitterMs();
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThanOrEqual(500);
    }
  });

  it('returns integers', () => {
    for (let i = 0; i < 100; i++) {
      const jitter = randomJitterMs();
      expect(Number.isInteger(jitter)).toBe(true);
    }
  });

  it('shows variation (not always the same value)', () => {
    const values = new Set<number>();
    for (let i = 0; i < 100; i++) {
      values.add(randomJitterMs());
    }
    expect(values.size).toBeGreaterThan(10);
  });
});

describe('randomizeMaxTokens', () => {
  it('returns a value within ±5% of the base, rounded to nearest 100', () => {
    const base = 1024;
    for (let i = 0; i < 200; i++) {
      const result = randomizeMaxTokens(base);
      expect(result % 100).toBe(0);
      // ±5% of 1024 = [972.8, 1075.2], rounded to 100 → [900, 1100]
      expect(result).toBeGreaterThanOrEqual(900);
      expect(result).toBeLessThanOrEqual(1100);
    }
  });

  it('returns at least 100 even for small base values', () => {
    for (let i = 0; i < 100; i++) {
      const result = randomizeMaxTokens(100);
      expect(result).toBeGreaterThanOrEqual(100);
    }
  });

  it('shows variation over many calls', () => {
    const values = new Set<number>();
    for (let i = 0; i < 200; i++) {
      values.add(randomizeMaxTokens(4096));
    }
    expect(values.size).toBeGreaterThan(1);
  });

  it('works with large token counts', () => {
    const base = 100000;
    for (let i = 0; i < 50; i++) {
      const result = randomizeMaxTokens(base);
      expect(result % 100).toBe(0);
      expect(result).toBeGreaterThanOrEqual(95000);
      expect(result).toBeLessThanOrEqual(105000);
    }
  });
});
