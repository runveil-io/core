/**
 * Metering Module - Types
 * 
 * Usage normalization, pricing, and witness types for settlement
 */

/**
 * Normalized usage from any provider format
 */
export interface NormalizedUsage {
  input: number;      // Input tokens
  output: number;     // Output tokens
  cacheRead?: number; // Cache read tokens (optional)
  cacheWrite?: number; // Cache write tokens (optional)
}

/**
 * Price configuration per model
 */
export interface PriceConfig {
  model: string;
  inputPerM: number;   // Price per 1M input tokens (USD)
  outputPerM: number;  // Price per 1M output tokens (USD)
  cacheReadPerM?: number;  // Price per 1M cache read tokens (optional)
  cacheWritePerM?: number; // Price per 1M cache write tokens (optional)
}

/**
 * Cost breakdown
 */
export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  totalCost: number;
}

/**
 * Witness record for settlement
 */
export interface Witness {
  request_id: string;
  usage: NormalizedUsage;
  cost: CostBreakdown;
  timestamp: number;
  relay_signature: string;
}

/**
 * Provider-specific usage formats
 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface GoogleUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
  cachedContentTokenCount?: number;
}

/**
 * Union type for any provider usage
 */
export type AnyUsage = AnthropicUsage | OpenAIUsage | GoogleUsage | Record<string, unknown>;
