import { createLogger } from '../../logger.js';
import type { RequestPayload, RequestResult, Usage, ProviderAdapter } from './types.js';

const log = createLogger('adapter/google');

export const googleAdapter: ProviderAdapter = {
  name: 'Google Gemini',
  provider: 'google',

  getModels(): string[] {
    return [
      'gemini-2.5-pro-preview-06-05',
      'gemini-2.5-flash-preview-05-20',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
    ];
  },

  handles(model: string): boolean {
    return model.startsWith('gemini-');
  },

  async sendRequest(
    payload: RequestPayload,
    apiKey: string,
    onChunk?: (chunk: string) => void,
    apiBase?: string,
  ): Promise<RequestResult> {
    const url = (apiBase ?? 'https://generativelanguage.googleapis.com') +
      `/v1beta/models/${payload.model}:generateContent?key=${apiKey}`;

    const contents = payload.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const systemInstruction = payload.messages.find((m) => m.role === 'system');

    const geminiRequest: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: payload.max_tokens,
        temperature: payload.temperature,
        topP: payload.top_p,
      },
    };

    if (systemInstruction) {
      geminiRequest.systemInstruction = {
        parts: [{ text: systemInstruction.content }],
      };
    }

    log.debug('gemini_req', { body: geminiRequest });

    const reqHeaders: Record<string, string> = {
      'content-type': 'application/json',
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(geminiRequest),
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error('upstream_auth');
      if (res.status === 400) {
        const errBody = await res.text();
        const body = JSON.parse(errBody) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'invalid_request');
      }
      throw new Error(`gemini_${res.status}`);
    }

    const body = await res.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
          finishReason?: string;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    };

    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text).join('') ?? '';
    const finishReason = candidate?.content?.finishReason ?? 'STOP';

    return {
      content: text,
      usage: {
        input_tokens: body.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      },
      finish_reason: finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
    };
  },
};
