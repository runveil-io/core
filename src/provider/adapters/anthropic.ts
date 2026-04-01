import { createLogger } from '../../logger.js';
import { MODEL_MAP, RETRY_CONFIG } from '../../config/bootstrap.js';
import type { InnerPlaintext } from '../../types.js';
import type { ProviderAdapter, ProviderAdapterResult } from './types.js';

const log = createLogger('adapter:anthropic');

export function getRetryDelay(attempt: number): number {
  const base = Math.min(
    RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
    RETRY_CONFIG.maxDelayMs,
  );
  const jitter = base * RETRY_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

function mapModel(model: string): string {
  return MODEL_MAP[model] ?? model;
}

export const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',
  
  canHandle(model: string): boolean {
    // Handles all models, but Anthropic models are the default
    // Only handle models that don't have a known prefix for other providers
    const knownPrefixes = ['gpt-', 'gemini-'];
    for (const prefix of knownPrefixes) {
      if (model.startsWith(prefix)) return false;
    }
    return true;
  },
  
  getModels(): string[] {
    return Object.keys(MODEL_MAP);
  },
  
  buildUrl(apiBase?: string): string {
    return (apiBase ?? 'https://api.anthropic.com') + '/v1/messages';
  },
  
  buildHeaders(apiKey: string, proxySecret?: string): Record<string, string> {
    const isOAuthToken = apiKey.includes('sk-ant-oat');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    
    if (proxySecret) {
      headers['x-proxy-secret'] = proxySecret;
    } else if (isOAuthToken) {
      // OAuth/setup-token: use Bearer auth + Claude Code headers
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      headers['user-agent'] = 'claude-cli/2.1.75';
      headers['x-app'] = 'cli';
      headers['accept'] = 'application/json';
    } else {
      // Standard API key
      headers['x-api-key'] = apiKey;
    }
    
    return headers;
  },
  
  buildBody(inner: InnerPlaintext, apiKey?: string): Record<string, unknown> {
    const anthropicModel = mapModel(inner.model);
    
    const systemMessage = inner.messages.find((m) => m.role === 'system');
    const nonSystemMessages = inner.messages.filter((m) => m.role !== 'system');
    
    const anthropicRequest: Record<string, unknown> = {
      model: anthropicModel,
      max_tokens: inner.max_tokens,
      messages: nonSystemMessages,
      temperature: inner.temperature,
      top_p: inner.top_p,
      stream: inner.stream,
    };
    
    if (systemMessage) {
      anthropicRequest.system = systemMessage.content;
    }
    if (inner.stop_sequences.length > 0) {
      anthropicRequest.stop_sequences = inner.stop_sequences;
    }
    
    // OAuth tokens require Claude Code system prompt (Anthropic-specific behavior)
    const isOAuthToken = apiKey?.includes('sk-ant-oat') ?? false;
    if (isOAuthToken && !anthropicRequest.system) {
      anthropicRequest.system = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }];
    } else if (isOAuthToken && typeof anthropicRequest.system === 'string') {
      anthropicRequest.system = [
        { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: 'text', text: anthropicRequest.system as string },
      ];
    }
    
    return anthropicRequest;
  },
  
  async parseResponse(res: Response): Promise<ProviderAdapterResult> {
    if (res.status === 400) {
      const errBody = await res.text();
      log.debug('anthropic_400', { body: errBody });
      const body = JSON.parse(errBody) as { error?: { message?: string } };
      throw new Error(body.error?.message ?? 'invalid_request');
    }
    
    if (res.status === 401) {
      throw new Error('upstream_auth');
    }
    
    const body = await res.json() as {
      content: Array<{ text: string }>;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };
    
    return {
      content: body.content.map((c) => c.text).join(''),
      usage: body.usage,
      finish_reason: body.stop_reason === 'end_turn' ? 'stop' : body.stop_reason === 'max_tokens' ? 'length' : 'stop',
    };
  },
  
  async parseStream(
    res: Response,
    onChunk: (chunk: string) => void,
  ): Promise<ProviderAdapterResult> {
    if (!res.body) throw new Error('no_response_body');
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = 'stop';
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data) continue;
        
        let event: {
          type: string;
          message?: { usage?: { input_tokens: number } };
          delta?: { type?: string; text?: string; stop_reason?: string };
          usage?: { output_tokens: number };
        };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        
        switch (event.type) {
          case 'message_start':
            inputTokens = event.message?.usage?.input_tokens ?? 0;
            break;
          case 'content_block_delta':
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              content += event.delta.text;
              onChunk(event.delta.text);
            }
            break;
          case 'message_delta':
            outputTokens = event.usage?.output_tokens ?? 0;
            if (event.delta?.stop_reason === 'end_turn') finishReason = 'stop';
            else if (event.delta?.stop_reason === 'max_tokens') finishReason = 'length';
            break;
        }
      }
    }
    
    return { content, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, finish_reason: finishReason };
  },
  
  extractUsage(data: unknown): { input_tokens: number; output_tokens: number } {
    const d = data as { usage?: { input_tokens: number; output_tokens: number } };
    return d?.usage ?? { input_tokens: 0, output_tokens: 0 };
  },
};
