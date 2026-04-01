import { createLogger } from '../../logger.js';
import type { RequestPayload, RequestResult, Usage, ProviderAdapter } from './types.js';

const log = createLogger('adapter/openai');

export const openaiAdapter: ProviderAdapter = {
  name: 'OpenAI',
  provider: 'openai',

  getModels(): string[] {
    return [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
    ];
  },

  handles(model: string): boolean {
    return model.startsWith('gpt-');
  },

  async sendRequest(
    payload: RequestPayload,
    apiKey: string,
    onChunk?: (chunk: string) => void,
    apiBase?: string,
  ): Promise<RequestResult> {
    const url = (apiBase ?? 'https://api.openai.com') + '/v1/chat/completions';

    const reqHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };

    const openaiMessages = payload.messages.map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    }));

    const openaiRequest: Record<string, unknown> = {
      model: payload.model,
      messages: openaiMessages,
      max_tokens: payload.max_tokens,
      temperature: payload.temperature,
      top_p: payload.top_p,
      stream: payload.stream ?? false,
    };

    if (payload.stop_sequences && payload.stop_sequences.length > 0) {
      openaiRequest.stop = payload.stop_sequences;
    }

    log.debug('openai_req', { body: openaiRequest });

    const res = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(openaiRequest),
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error('upstream_auth');
      if (res.status === 400) {
        const errBody = await res.text();
        const body = JSON.parse(errBody) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'invalid_request');
      }
      throw new Error(`openai_${res.status}`);
    }

    if (!payload.stream) {
      const body = await res.json() as {
        choices: Array<{ message: { content: string }; finish_reason: string }>;
        usage: Usage;
      };
      return {
        content: body.choices[0]?.message?.content ?? '',
        usage: body.usage,
        finish_reason: body.choices[0]?.finish_reason ?? 'stop',
      };
    }

    if (!res.body) throw new Error('no_response_body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = 'stop';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        let event: {
          choices?: Array<{
            delta?: { content?: string; finish_reason?: string };
            finish_reason?: string;
          }>;
          usage?: Usage;
        };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = event.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          onChunk?.(delta.content);
        }
        if (delta?.finish_reason) {
          finishReason = delta.finish_reason;
        }
        if (event.usage) {
          inputTokens = event.usage.input_tokens;
          outputTokens = event.usage.output_tokens;
        }
      }
    }

    return {
      content,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      finish_reason: finishReason,
    };
  },
};
