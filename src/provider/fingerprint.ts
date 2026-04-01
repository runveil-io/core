/**
 * Fingerprint randomization utilities for Anthropic API requests.
 *
 * Ensures no two consecutive requests share identical header fingerprints
 * by randomizing anthropic-version, User-Agent, request delay, and max_tokens.
 */

// Compatible anthropic-version header values
const ANTHROPIC_VERSIONS = [
  '2023-01-01',
  '2023-06-01',
  '2024-01-01',
  '2024-02-15',
  '2024-06-01',
  '2024-10-22',
];

// Realistic User-Agent strings
const USER_AGENTS = [
  'anthropic-sdk/node-0.24.0',
  'anthropic-sdk/node-0.25.1',
  'anthropic-sdk/node-0.26.0',
  'anthropic-sdk/python-0.28.0',
  'anthropic-sdk/python-0.29.1',
  'anthropic-sdk/python-0.30.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
];

/** Max jitter delay in milliseconds */
const MAX_JITTER_MS = 500;

/** Max tokens variation percentage */
const MAX_TOKENS_VARIATION = 0.05;

/** Tracks last-used values to avoid consecutive duplicates */
let lastVersion: string | null = null;
let lastUserAgent: string | null = null;

/**
 * Pick a random element from the array, avoiding the excluded value.
 * If the array has only one element, returns it regardless.
 */
function pickRandom<T>(pool: T[], exclude: T | null): T {
  if (pool.length <= 1) return pool[0];
  let choice: T;
  do {
    choice = pool[Math.floor(Math.random() * pool.length)];
  } while (choice === exclude);
  return choice;
}

/** Returns a randomized anthropic-version header, never the same as the last call. */
export function randomizeVersion(): string {
  const version = pickRandom(ANTHROPIC_VERSIONS, lastVersion);
  lastVersion = version;
  return version;
}

/** Returns a randomized User-Agent string, never the same as the last call. */
export function randomizeUserAgent(): string {
  const ua = pickRandom(USER_AGENTS, lastUserAgent);
  lastUserAgent = ua;
  return ua;
}

/** Returns a random delay in ms, uniformly distributed in [0, 500]. */
export function randomJitterMs(): number {
  return Math.floor(Math.random() * (MAX_JITTER_MS + 1));
}

/**
 * Randomize max_tokens by ±5%, rounded to the nearest 100.
 * Guarantees the result is at least 100.
 */
export function randomizeMaxTokens(baseTokens: number): number {
  const variation = 1 + (Math.random() * 2 - 1) * MAX_TOKENS_VARIATION;
  const jittered = baseTokens * variation;
  const rounded = Math.round(jittered / 100) * 100;
  return Math.max(100, rounded);
}

/** Sleep for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reset internal state (for testing). */
export function _resetState(): void {
  lastVersion = null;
  lastUserAgent = null;
}

/** Expose pools for testing. */
export const _pools = {
  ANTHROPIC_VERSIONS,
  USER_AGENTS,
  MAX_JITTER_MS,
  MAX_TOKENS_VARIATION,
};
