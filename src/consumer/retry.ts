import {
  Provider,
  ProviderError,
  ProviderRequest,
  ProviderResponse,
  RetryConfig,
  RequestFn,
  DelayFn,
  DEFAULT_RETRY_CONFIG,
} from './types.js';

function getBackoffDelay(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * Math.pow(2, attempt);
}

function selectNextProvider(
  providers: Provider[],
  failedProvider: Provider,
): Provider | null {
  const remaining = providers.filter((p) => p.id !== failedProvider.id);
  return remaining.length > 0 ? remaining[0] : null;
}

export async function executeWithRetry(
  providers: Provider[],
  request: ProviderRequest,
  requestFn: RequestFn,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  delayFn: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<ProviderResponse> {
  if (providers.length === 0) {
    throw new Error('No providers available');
  }

  // No retry for streaming requests
  if (request.stream) {
    return requestFn(providers[0], request);
  }

  let lastError: ProviderError | Error | undefined;
  let currentProvider = providers[0];
  const triedProviders = new Set<string>();

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await requestFn(currentProvider, request);
    } catch (error) {
      lastError = error as ProviderError | Error;

      // Don't retry on 4xx client errors
      if (error instanceof ProviderError && error.isClientError) {
        throw error;
      }

      // Don't retry if we've exhausted all attempts
      if (attempt >= config.maxRetries) {
        break;
      }

      // Wait with exponential backoff before retrying
      await delayFn(getBackoffDelay(attempt, config.baseDelayMs));

      // Try a different provider if available
      triedProviders.add(currentProvider.id);
      const nextProvider = selectNextProvider(
        providers.filter((p) => !triedProviders.has(p.id)),
        currentProvider,
      );
      if (nextProvider) {
        currentProvider = nextProvider;
      }
      // If no alternative provider, retry on same provider
    }
  }

  throw lastError;
}
