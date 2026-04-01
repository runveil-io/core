import { describe, it, expect, vi } from 'vitest';
import {
  executeWithRetry,
  Provider,
  ProviderRequest,
  ProviderResponse,
  ProviderError,
  RetryConfig,
} from '../src/consumer/index.js';

const makeProvider = (id: string): Provider => ({
  id,
  name: `Provider ${id}`,
  endpoint: `https://${id}.example.com`,
});

const providerA = makeProvider('a');
const providerB = makeProvider('b');
const providerC = makeProvider('c');

const request: ProviderRequest = { method: 'POST', path: '/v1/chat' };

const successResponse = (provider: Provider): ProviderResponse => ({
  status: 200,
  data: { result: 'ok' },
  provider,
});

const config: RetryConfig = { maxRetries: 3, baseDelayMs: 1000 };

// Instant delay for tests
const noDelay = vi.fn(async (_ms: number) => {});

describe('executeWithRetry', () => {
  describe('successful requests', () => {
    it('returns response on first attempt success', async () => {
      const requestFn = vi.fn(async (provider: Provider) =>
        successResponse(provider),
      );

      const result = await executeWithRetry(
        [providerA],
        request,
        requestFn,
        config,
        noDelay,
      );

      expect(result.status).toBe(200);
      expect(result.provider.id).toBe('a');
      expect(requestFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry on 5xx errors', () => {
    it('retries up to 3 times on server errors', async () => {
      const requestFn = vi.fn(async (provider: Provider) => {
        throw new ProviderError('Internal Server Error', 500, provider);
      });

      await expect(
        executeWithRetry([providerA], request, requestFn, config, noDelay),
      ).rejects.toThrow(ProviderError);

      // 1 initial + 3 retries = 4 total calls
      expect(requestFn).toHaveBeenCalledTimes(4);
    });

    it('succeeds after retries on 5xx', async () => {
      let callCount = 0;
      const requestFn = vi.fn(async (provider: Provider) => {
        callCount++;
        if (callCount < 3) {
          throw new ProviderError('Server Error', 503, provider);
        }
        return successResponse(provider);
      });

      const result = await executeWithRetry(
        [providerA],
        request,
        requestFn,
        config,
        noDelay,
      );

      expect(result.status).toBe(200);
      expect(requestFn).toHaveBeenCalledTimes(3);
    });

    it('retries on generic (non-ProviderError) errors', async () => {
      let callCount = 0;
      const requestFn = vi.fn(async (provider: Provider) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network timeout');
        }
        return successResponse(provider);
      });

      const result = await executeWithRetry(
        [providerA],
        request,
        requestFn,
        config,
        noDelay,
      );

      expect(result.status).toBe(200);
      expect(requestFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('exponential backoff timing', () => {
    it('uses exponential backoff: 1s, 2s, 4s', async () => {
      const delays: number[] = [];
      const trackDelay = async (ms: number) => {
        delays.push(ms);
      };

      const requestFn = vi.fn(async (provider: Provider) => {
        throw new ProviderError('Server Error', 500, provider);
      });

      await expect(
        executeWithRetry([providerA], request, requestFn, config, trackDelay),
      ).rejects.toThrow();

      expect(delays).toEqual([1000, 2000, 4000]);
    });

    it('respects custom baseDelayMs', async () => {
      const delays: number[] = [];
      const trackDelay = async (ms: number) => {
        delays.push(ms);
      };

      const customConfig: RetryConfig = { maxRetries: 3, baseDelayMs: 500 };

      const requestFn = vi.fn(async (provider: Provider) => {
        throw new ProviderError('Server Error', 500, provider);
      });

      await expect(
        executeWithRetry(
          [providerA],
          request,
          requestFn,
          customConfig,
          trackDelay,
        ),
      ).rejects.toThrow();

      expect(delays).toEqual([500, 1000, 2000]);
    });
  });

  describe('no retry on 4xx errors', () => {
    it('does not retry on 400 Bad Request', async () => {
      const requestFn = vi.fn(async (provider: Provider) => {
        throw new ProviderError('Bad Request', 400, provider);
      });

      await expect(
        executeWithRetry([providerA], request, requestFn, config, noDelay),
      ).rejects.toThrow(ProviderError);

      expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it('does not retry on 401 Unauthorized', async () => {
      const requestFn = vi.fn(async (provider: Provider) => {
        throw new ProviderError('Unauthorized', 401, provider);
      });

      await expect(
        executeWithRetry([providerA], request, requestFn, config, noDelay),
      ).rejects.toThrow(ProviderError);

      expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it('does not retry on 404 Not Found', async () => {
      const requestFn = vi.fn(async (provider: Provider) => {
        throw new ProviderError('Not Found', 404, provider);
      });

      await expect(
        executeWithRetry([providerA], request, requestFn, config, noDelay),
      ).rejects.toThrow(ProviderError);

      expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it('does not retry on 429 Too Many Requests', async () => {
      const requestFn = vi.fn(async (provider: Provider) => {
        throw new ProviderError('Too Many Requests', 429, provider);
      });

      await expect(
        executeWithRetry([providerA], request, requestFn, config, noDelay),
      ).rejects.toThrow(ProviderError);

      expect(requestFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('no retry mid-stream', () => {
    it('does not retry streaming requests', async () => {
      const streamRequest: ProviderRequest = {
        method: 'POST',
        path: '/v1/chat',
        stream: true,
      };

      const requestFn = vi.fn(async (provider: Provider) => {
        throw new ProviderError('Server Error', 500, provider);
      });

      await expect(
        executeWithRetry(
          [providerA, providerB],
          streamRequest,
          requestFn,
          config,
          noDelay,
        ),
      ).rejects.toThrow(ProviderError);

      // Only 1 call — no retries for streaming
      expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it('succeeds on first attempt for streaming request', async () => {
      const streamRequest: ProviderRequest = {
        method: 'POST',
        path: '/v1/chat',
        stream: true,
      };

      const requestFn = vi.fn(async (provider: Provider) =>
        successResponse(provider),
      );

      const result = await executeWithRetry(
        [providerA],
        streamRequest,
        requestFn,
        config,
        noDelay,
      );

      expect(result.status).toBe(200);
      expect(requestFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('provider rotation', () => {
    it('tries different provider on retry when multiple available', async () => {
      const calledProviders: string[] = [];
      let callCount = 0;

      const requestFn = vi.fn(async (provider: Provider) => {
        calledProviders.push(provider.id);
        callCount++;
        if (callCount === 1) {
          throw new ProviderError('Server Error', 502, provider);
        }
        return successResponse(provider);
      });

      const result = await executeWithRetry(
        [providerA, providerB],
        request,
        requestFn,
        config,
        noDelay,
      );

      expect(result.status).toBe(200);
      expect(calledProviders[0]).toBe('a');
      expect(calledProviders[1]).toBe('b');
    });

    it('rotates through all available providers', async () => {
      const calledProviders: string[] = [];
      let callCount = 0;

      const requestFn = vi.fn(async (provider: Provider) => {
        calledProviders.push(provider.id);
        callCount++;
        if (callCount <= 2) {
          throw new ProviderError('Server Error', 500, provider);
        }
        return successResponse(provider);
      });

      const result = await executeWithRetry(
        [providerA, providerB, providerC],
        request,
        requestFn,
        config,
        noDelay,
      );

      expect(result.status).toBe(200);
      expect(calledProviders).toEqual(['a', 'b', 'c']);
    });

    it('falls back to same provider when all others exhausted', async () => {
      const calledProviders: string[] = [];

      const requestFn = vi.fn(async (provider: Provider) => {
        calledProviders.push(provider.id);
        throw new ProviderError('Server Error', 500, provider);
      });

      await expect(
        executeWithRetry(
          [providerA, providerB],
          request,
          requestFn,
          config,
          noDelay,
        ),
      ).rejects.toThrow();

      // a -> b -> (no more new providers, stays on b) -> b
      expect(calledProviders.length).toBe(4);
      expect(calledProviders[0]).toBe('a');
      expect(calledProviders[1]).toBe('b');
    });
  });

  describe('edge cases', () => {
    it('throws when no providers given', async () => {
      const requestFn = vi.fn();

      await expect(
        executeWithRetry([], request, requestFn, config, noDelay),
      ).rejects.toThrow('No providers available');

      expect(requestFn).not.toHaveBeenCalled();
    });

    it('works with single provider and retries on same', async () => {
      let callCount = 0;
      const requestFn = vi.fn(async (provider: Provider) => {
        callCount++;
        if (callCount <= 2) {
          throw new ProviderError('Server Error', 500, provider);
        }
        return successResponse(provider);
      });

      const result = await executeWithRetry(
        [providerA],
        request,
        requestFn,
        config,
        noDelay,
      );

      expect(result.status).toBe(200);
      expect(requestFn).toHaveBeenCalledTimes(3);
    });
  });
});
