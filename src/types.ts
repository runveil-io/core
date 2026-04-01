// Wire protocol types

export type MessageType =
  | 'provider_hello'
  | 'provider_ack'
  | 'request'
  | 'response'
  | 'stream_start'
  | 'stream_chunk'
  | 'stream_end'
  | 'error'
  | 'ping'
  | 'pong'
  | 'list_providers'
  | 'provider_list';

export interface WsMessage {
  type: MessageType;
  request_id?: string;
  payload?: unknown;
  timestamp: number;
}

export interface ProviderHelloPayload {
  provider_pubkey: string;
  encryption_pubkey: string;
  models: string[];
  capacity: number;
  signature: string;
}

export interface ProviderAckPayload {
  status: 'accepted' | 'rejected';
  reason?: string;
}

export interface RequestPayload {
  outer: {
    consumer_pubkey: string;
    provider_id: string;
    model: string;
    signature: string;
  };
  inner: string;
}

export interface ResponsePayload {
  encrypted_body: string;
}

export interface StreamStartPayload {
  model: string;
}

export interface StreamChunkPayload {
  encrypted_chunk: string;
  index: number;
}

export interface StreamEndPayload {
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface ProviderListPayload {
  providers: Array<{
    provider_id: string;
    encryption_pubkey: string;
    models: string[];
    capacity: number;
  }>;
}

export interface InnerPlaintext {
  messages: Array<{ role: string; content: string }>;
  model: string;
  max_tokens: number;
  temperature: number;
  top_p: number;
  stop_sequences: string[];
  stream: boolean;
}

// OpenAI-compatible types

export interface ChatCompletionRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop' | 'length';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

export interface ProviderInfo {
  provider_id: string;
  encryption_pubkey: string;
  models: string[];
  capacity: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy';
  uptime: number;
  models: string[];
  capacity: number;
  version: string;
}

export type ProviderHealthStatus = 'healthy' | 'degraded' | 'down';

export interface ProviderMetrics {
  provider_id: string;
  latency_ms: number;
  capacity: number;
  available_capacity: number;
  health: ProviderHealthStatus;
  consecutive_failures: number;
  last_failure_at?: number;
  last_success_at?: number;
  score?: number;
  score_cached_at?: number;
}

export interface ProviderSelectionCriteria {
  model: string;
  preferred_provider_id?: string;
  max_latency_ms?: number;
  min_capacity?: number;
}

export interface ProviderSelectorConfig {
  score_ttl_ms: number;
  circuit_breaker_threshold: number;
  circuit_breaker_reset_ms: number;
  capacity_weight: number;
  latency_weight: number;
}