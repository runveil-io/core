export async function handleRequest(
  inner: InnerPlaintext,
  apiKey: string,
  onChunk?: (chunk: string) => void,
  apiBase?: string,
  proxySecret?: string,
): Promise<HandleRequestResult> {
  const anthropicModel = MODEL_MAP[inner.model] ?? inner.model;
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
  const url = (apiBase ?? 'https://api.anthropic.com') + '/v1/messages';
  const isOAuthToken = apiKey.includes('sk-ant-oat');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (proxySecret) {
    headers['x-proxy-secret'] = proxySecret;
  } else if (isOAuthToken) {
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    headers['user-agent'] = 'claude-cli/2.1.75';
    headers['x-app'] = 'cli';
    headers['accept'] = 'application/json';
  } else {
    headers['x-api-key'] = apiKey;
  }
  if (isOAuthToken && !anthropicRequest.system) {
    anthropicRequest.system = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }];
  } else if (isOAuthToken && typeof anthropicRequest.system === 'string') {
    anthropicRequest.system = [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text', text: anthropicRequest.system },
    ];
  }
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(anthropicRequest),
      });
      if (res.status === 429 || res.status === 529 || res.status === 500) {
        lastError = new Error(`anthropic_${res.status}`);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, [1000, 2000, 4000][attempt]));
          continue;
        }
        throw lastError;
      }
      if (res.status === 400) {
        const errBody = await res.text();
        const body = JSON.parse(errBody) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'invalid_request');
      }
      if (res.status === 401) {
        throw new Error('upstream_auth');
      }
      if (!inner.stream) {
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
      }
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
          let event: { type: string; message?: { usage?: { input_tokens: number } }; delta?: { type?: string; text?: string; stop_reason?: string }; usage?: { output_tokens: number } };
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
                onChunk?.(event.delta.text);
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
    } catch (err) {
      lastError = err as Error;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, [1000, 2000, 4000][attempt]));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error('max_retries_exceeded');
}