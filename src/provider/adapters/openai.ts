import { createLogger } from '../../logger.js';
import { RETRY_CONFIG } from '../../config/bootstrap.js';
import type { InnerPlaintext } from '../../types.js';
import type { ProviderAdapter, ProviderAdapterResult } from './types.js';

const log = createLogger('adapter:openai');

function getRetryDelay(attempt: number): number {
  const base = Math.min(
    RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
    RETRY_CONFIG.maxDelayMs,
  );
  const jitter = base * RETRY_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

// OpenAI models supported by this adapter
export const OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
];

function mapModel(model: string): string {
  // Map generic gpt-* to OpenAI model IDs
  // If already a full model ID, return as-is
  if (model.startsWith('gpt-')) {
    return model;
  }
  return model;
}

export const openaiAdapter: ProviderAdapter = {
  name: 'openai',
  
  canHandle(model: string): boolean {
    return model.startsWith('gpt-');
  },
  
  getModels(): string[] {
    return [...OPENAI_MODELS];
  },
  
  buildUrl(apiBase?: string): string {
    return (apiBase ?? 'https://api.openai.com') + '/v1/chat/completions';
  },
  
  buildHeaders(apiKey: string, proxySecret?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    
    if (proxySecret) {
      headers['x-proxy-secret'] = proxySecret;
    }
    
    return headers;
  },
  
  buildBody(inner: InnerPlaintext): Record<string, unknown> {
    const openaiModel = mapModel(inner.model);
    
    // OpenAI uses a different message format
    // Convert messages to OpenAI format (content is just string for now)
    const messages = inner.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
    
    const body: Record<string, unknown> = {
      model: openaiModel,
      messages,
      max_tokens: inner.max_tokens,
      temperature: inner.temperature,
      top_p: inner.top_p,
      stream: inner.stream,
    };
    
    if (inner.stop_sequences.length > 0) {
      body.stop = inner.stop_sequences;
    }
    
    return body;
  },
  
  async parseResponse(res: Response): Promise<ProviderAdapterResult> {
    if (res.status === 400) {
      const errBody = await res.text();
      log.debug('openai_400', { body: errBody });
      const body = JSON.parse(errBody) as { error?: { message?: string } };
      throw new Error(body.error?.message ?? 'invalid_request');
    }
    
    if (res.status === 401) {
      throw new Error('upstream_auth');
    }
    
    const body = await res.json() as {
      choices: Array<{
        message: { content: string };
        finish_reason: string;
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };
    
    const choice = body.choices[0];
    return {
      content: choice.message.content,
      usage: {
        input_tokens: body.usage?.prompt_tokens ?? 0,
        output_tokens: body.usage?.completion_tokens ?? 0,
      },
      finish_reason: choice.finish_reason === 'stop' ? 'stop' : choice.finish_reason === 'length' ? 'length' : 'stop',
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
        if (!data || data === '[DONE]') continue;
        
        try {
          const event = JSON.parse(data) as {
            choices?: Array<{
              delta?: { content?: string };
              finish_reason?: string;
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
            };
          };
          
          if (event.usage) {
            inputTokens = event.usage.prompt_tokens ?? 0;
            outputTokens = event.usage.completion_tokens ?? 0;
          }
          
          const delta = event.choices?.[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            onChunk(delta.content);
          }
          
          if (event.choices?.[0]?.finish_reason) {
            const fr = event.choices[0].finish_reason;
            if (fr === 'stop') finishReason = 'stop';
            else if (fr === 'length') finishReason = 'length';
          }
        } catch {
          continue;
        }
      }
    }
    
    return { content, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, finish_reason: finishReason };
  },
  
  extractUsage(data: unknown): { input_tokens: number; output_tokens: number } {
    const d = data as { usage?: { prompt_tokens: number; completion_tokens: number } };
    return {
      input_tokens: d?.usage?.prompt_tokens ?? 0,
      output_tokens: d?.usage?.completion_tokens ?? 0,
    };
  },
};
