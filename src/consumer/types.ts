export interface Provider {
  id: string;
  name: string;
  endpoint: string;
}

export interface ProviderRequest {
  method: string;
  path: string;
  body?: unknown;
  stream?: boolean;
}

export interface ProviderResponse {
  status: number;
  data: unknown;
  provider: Provider;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly provider: Provider,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  get isServerError(): boolean {
    return this.status >= 500;
  }
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
};

export type RequestFn = (
  provider: Provider,
  request: ProviderRequest,
) => Promise<ProviderResponse>;

export type DelayFn = (ms: number) => Promise<void>;
