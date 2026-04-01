import { createLogger } from '../../logger.js';
import { RETRY_CONFIG } from '../../config/bootstrap.js';
import type { InnerPlaintext } from '../../types.js';
import type { ProviderAdapter, ProviderAdapterResult } from './types.js';

const log = createLogger('adapter:google');

function getRetryDelay(attempt: number): number {
  const base = Math.min(
    RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
    RETRY_CONFIG.maxDelayMs,
  );
  const jitter = base * RETRY_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

// Google Gemini models supported by this adapter
export const GOOGLE_MODELS = [
  'gemini-2.5-pro-preview-06',
  'gemini-2.5-flash-preview-06',
  'gemini-2.0-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
];

function mapModel(model: string): string {
  // Map generic gemini-* to Google model IDs
  if (model.startsWith('gemini-')) {
    return model;
  }
  return model;
}

export const googleAdapter: ProviderAdapter = {
  name: 'google',
  
  canHandle(model: string): boolean {
    return model.startsWith('gemini-');
  },
  
  getModels(): string[] {
    return [...GOOGLE_MODELS];
  },
  
  buildUrl(apiBase?: string, model?: string, stream?: boolean): string {
    const modelName = model ? mapModel(model) : mapModel(this.getModels()[0]);
    // Gemini uses a different URL format with model in path
    // For streaming, use alt=sse query parameter
    const base = (apiBase ?? 'https://generativelanguage.googleapis.com') + `/v1beta1/models/${modelName}:generateContent`;
    return stream ? `${base}?alt=sse` : base;
  },
  
  buildHeaders(apiKey: string, proxySecret?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    
    if (proxySecret) {
      headers['x-proxy-secret'] = proxySecret;
    }
    
    // Google uses API key as query param
    return headers;
  },
  
  buildBody(inner: InnerPlaintext): Record<string, unknown> {
    // Convert messages to Gemini format
    // Gemini uses contents: [{ role: 'user'/'model', parts: [{ text: '...' }] }]
    const contents = inner.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : m.role,
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    }));
    
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: inner.max_tokens,
        temperature: inner.temperature,
        topP: inner.top_p,
      },
    };
    
    if (inner.stop_sequences.length > 0) {
      body.generationConfig.stopSequences = inner.stop_sequences;
    }
    
    return body;
  },
  
  buildUrlWithModel(model: string, apiBase?: string): string {
    const mappedModel = mapModel(model);
    return (apiBase ?? 'https://generativelanguage.googleapis.com') + `/v1beta1/models/${mappedModel}:generateContent`;
  },
  
  async parseResponse(res: Response): Promise<ProviderAdapterResult> {
    if (res.status === 400) {
      const errBody = await res.text();
      log.debug('google_400', { body: errBody });
      const body = JSON.parse(errBody) as { error?: { message?: string } };
      throw new Error(body.error?.message ?? 'invalid_request');
    }
    
    if (res.status === 401) {
      throw new Error('upstream_auth');
    }
    
    const body = await res.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };
    
    const candidate = body.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const content = parts.map((p) => p.text ?? '').join('');
    
    let finishReason = 'stop';
    if (candidate?.finishReason) {
      if (candidate.finishReason === 'MAX_TOKENS') finishReason = 'length';
      else if (candidate.finishReason === 'STOP') finishReason = 'stop';
      else if (candidate.finishReason === 'SAFETY') finishReason = 'stop';
      else if (candidate.finishReason === 'RECITATION') finishReason = 'stop';
    }
    
    return {
      content,
      usage: {
        input_tokens: body.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      },
      finish_reason: finishReason,
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
      
      // Google SSE streaming format: "data: {...}\n\n"
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      
      for (const line of lines) {
        // Skip empty lines and event type lines
        if (!line.trim()) continue;
        
        // Extract JSON from SSE format: "data: {...}" or just "{...}"
        let jsonStr = line;
        if (line.startsWith('data: ')) {
          jsonStr = line.slice(6).trim();
        }
        
        if (!jsonStr.startsWith('{')) continue;
        
        try {
          const event = JSON.parse(jsonStr) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ text?: string }>;
              };
              finishReason?: string;
            }>;
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
            };
          };
          
          if (event.usageMetadata) {
            inputTokens = event.usageMetadata.promptTokenCount ?? 0;
            outputTokens = event.usageMetadata.candidatesTokenCount ?? 0;
          }
          
          const parts = event.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part.text) {
              content += part.text;
              onChunk(part.text);
            }
          }
          
          if (event.candidates?.[0]?.finishReason) {
            const fr = event.candidates[0].finishReason;
            if (fr === 'MAX_TOKENS') finishReason = 'length';
            else if (fr === 'STOP') finishReason = 'stop';
          }
        } catch {
          continue;
        }
      }
    }
    
    return { content, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, finish_reason: finishReason };
  },
  
  extractUsage(data: unknown): { input_tokens: number; output_tokens: number } {
    const d = data as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
    return {
      input_tokens: d?.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: d?.usageMetadata?.candidatesTokenCount ?? 0,
    };
  },
};
