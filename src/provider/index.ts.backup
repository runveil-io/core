import { connect } from '../network/index.js';
import { open, seal, sign, toHex, fromHex } from '../crypto/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('provider');
import { MODEL_MAP, RETRY_CONFIG } from '../config/bootstrap.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Connection } from '../network/index.js';
import type { Wallet } from '../wallet/index.js';
import type {
  WsMessage,
  RequestPayload,
  InnerPlaintext,
  StreamChunkPayload,
} from '../types.js';

const PROVIDER_VERSION = '0.1.0';
const DEFAULT_HEALTH_PORT = 9962;

export interface ProviderOptions {
  wallet: Wallet;
  relayUrl: string;
  apiKeys: Array<{ provider: 'anthropic'; key: string }>;
  maxConcurrent: number;
  proxyUrl?: string;      // e.g. http://127.0.0.1:4000
  proxySecret?: string;   // shared secret for proxy auth
  healthPort?: number;    // port for /health endpoint (default 9962)
}

export interface HandleRequestResult {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  finish_reason: string;
}

function getRetryDelay(attempt: number): number {
  const base = Math.min(
    RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
    RETRY_CONFIG.maxDelayMs,
  );
  const jitter = base * RETRY_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, base + jitter);
}

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

  log.debug('anthropic_req', { body: anthropicRequest });
  const url = (apiBase ?? 'https://api.anthropic.com') + '/v1/messages';
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
  
  // OAuth tokens require Claude Code system prompt
  if (isOAuthToken && !anthropicRequest.system) {
    anthropicRequest.system = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }];
  } else if (isOAuthToken && typeof anthropicRequest.system === 'string') {
    anthropicRequest.system = [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text', text: anthropicRequest.system },
    ];
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, getRetryDelay(attempt - 1)));
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(anthropicRequest),
      });
    } catch (err) {
      lastError = err as Error;
      continue;
    }

    log.debug('anthropic_status', { status: res.status });
    if (res.status === 429 || res.status === 529 || res.status === 500) {
      lastError = new Error(`anthropic_${res.status}`);
      if (attempt < RETRY_CONFIG.maxRetries) continue;
      throw lastError;
    }

    if (res.status === 400) {
      const errBody = await res.text(); log.debug('anthropic_400', { body: errBody }); const body = JSON.parse(errBody) as { error?: { message?: string } };
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

    // Streaming
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
  }

  throw lastError ?? new Error('max_retries_exceeded');
}

export async function startProvider(options: ProviderOptions): Promise<{ close(): Promise<void> }> {
  const { wallet, relayUrl, apiKeys, maxConcurrent, proxyUrl, proxySecret } = options;
  const apiKey = proxyUrl ? 'proxy' : apiKeys.find((k) => k.provider === 'anthropic')?.key;
  if (!apiKey && !proxyUrl) throw new Error('No Anthropic API key or proxy configured');
  const apiBase = proxyUrl ?? undefined;

  let activeRequests = 0;

  const conn = await connect({
    url: relayUrl,
    onMessage(msg: WsMessage) {
      if (msg.type === 'provider_ack') {
        const payload = msg.payload as { status: string; reason?: string };
        if (payload.status === 'rejected') {
          log.error('provider_rejected', { reason: payload.reason });
        } else {
          log.info('provider_accepted');
        }
        return;
      }

      if (msg.type === 'request') {
        if (activeRequests >= maxConcurrent) {
          conn.send({
            type: 'error',
            request_id: msg.request_id,
            payload: { code: 'rate_limit', message: 'Provider at capacity' },
            timestamp: Date.now(),
          });
          return;
        }
        handleIncomingRequest(msg).catch((err) => {
          log.error('request_error', { error: (err as Error).message });
        });
      }

      if (msg.type === 'pong') return;
    },
    onClose(code, reason) {
      log.warn('relay_disconnected', { code, reason });
    },
    onError(err) {
      log.error('relay_error', { error: err.message });
    },
  });

  // Send provider_hello
  const models = Object.keys(MODEL_MAP);
  const helloPayload = {
    provider_pubkey: toHex(wallet.signingPublicKey),
    encryption_pubkey: toHex(wallet.encryptionPublicKey),
    models,
    capacity: 100,
  };
  const timestamp = Date.now();
  const signable = JSON.stringify({ ...helloPayload, timestamp });
  const signature = sign(new TextEncoder().encode(signable), wallet.signingSecretKey);

  conn.send({
    type: 'provider_hello',
    payload: { ...helloPayload, signature: toHex(signature) },
    timestamp,
  });

  async function handleIncomingRequest(msg: WsMessage): Promise<void> {
    activeRequests++;
    const requestId = msg.request_id!;
    try {
      const payload = msg.payload as RequestPayload;
      const innerBytes = Buffer.from(payload.inner, 'base64');

      // Decrypt inner envelope
      const plaintext = open(new Uint8Array(innerBytes), wallet.encryptionSecretKey);
      if (!plaintext) {
        conn.send({
          type: 'error',
          request_id: requestId,
          payload: { code: 'decrypt_failed', message: 'Failed to decrypt request' },
          timestamp: Date.now(),
        });
        return;
      }

      // Extract consumer encryption pubkey for response encryption
      const consumerEncPubkey = innerBytes.slice(0, 32);
      const inner: InnerPlaintext = JSON.parse(new TextDecoder().decode(plaintext));

      if (inner.stream) {
        // Streaming mode
        conn.send({
          type: 'stream_start',
          request_id: requestId,
          payload: { model: inner.model },
          timestamp: Date.now(),
        });

        // Send first chunk with role
        const roleChunk = JSON.stringify({ role: 'assistant' });
        const sealedRole = seal(
          new TextEncoder().encode(roleChunk),
          new Uint8Array(consumerEncPubkey),
          wallet.encryptionSecretKey,
        );
        conn.send({
          type: 'stream_chunk',
          request_id: requestId,
          payload: {
            encrypted_chunk: Buffer.from(sealedRole).toString('base64'),
            index: 0,
          } satisfies import('../types.js').StreamChunkPayload,
          timestamp: Date.now(),
        });

        let chunkIndex = 1;
        const result = await handleRequest(inner, apiKey!, (text) => {
          const sealed = seal(
            new TextEncoder().encode(text),
            new Uint8Array(consumerEncPubkey),
            wallet.encryptionSecretKey,
          );
          conn.send({
            type: 'stream_chunk',
            request_id: requestId,
            payload: {
              encrypted_chunk: Buffer.from(sealed).toString('base64'),
              index: chunkIndex++,
            } satisfies StreamChunkPayload,
            timestamp: Date.now(),
          });
        }, apiBase, proxySecret);

        // Send finish_reason chunk
        const finishChunk = JSON.stringify({ finish_reason: result.finish_reason });
        const sealedFinish = seal(
          new TextEncoder().encode(finishChunk),
          new Uint8Array(consumerEncPubkey),
          wallet.encryptionSecretKey,
        );
        conn.send({
          type: 'stream_chunk',
          request_id: requestId,
          payload: {
            encrypted_chunk: Buffer.from(sealedFinish).toString('base64'),
            index: chunkIndex++,
          } satisfies StreamChunkPayload,
          timestamp: Date.now(),
        });

        conn.send({
          type: 'stream_end',
          request_id: requestId,
          payload: { usage: result.usage },
          timestamp: Date.now(),
        });
      } else {
        // Non-streaming mode
        const result = await handleRequest(inner, apiKey!, undefined, apiBase, proxySecret);
        const responseBody = JSON.stringify({
          content: result.content,
          usage: result.usage,
          finish_reason: result.finish_reason,
        });
        const sealed = seal(
          new TextEncoder().encode(responseBody),
          new Uint8Array(consumerEncPubkey),
          wallet.encryptionSecretKey,
        );
        conn.send({
          type: 'response',
          request_id: requestId,
          payload: { encrypted_body: Buffer.from(sealed).toString('base64') },
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      log.error('provider_request_error', { error: message });
      const code = message === 'decrypt_failed' ? 'decrypt_failed'
        : message === 'upstream_auth' ? 'api_error'
        : message.startsWith('anthropic_') ? 'api_error'
        : 'api_error';
      conn.send({
        type: 'error',
        request_id: requestId,
        payload: { code, message },
        timestamp: Date.now(),
      });
    } finally {
      activeRequests--;
    }
  }

  // Start health HTTP server
  const startTime = Date.now();
  const healthPort = options.healthPort
    ?? (process.env['VEIL_PROVIDER_HEALTH_PORT'] ? Number(process.env['VEIL_PROVIDER_HEALTH_PORT']) : undefined)
    ?? DEFAULT_HEALTH_PORT;
  const healthModels = Object.keys(MODEL_MAP);
  const capacity = options.maxConcurrent;

  const healthApp = new Hono();
  healthApp.get('/health', (c) => {
    return c.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      models: healthModels,
      capacity,
      version: PROVIDER_VERSION,
    });
  });

  let healthServer: ReturnType<typeof serve> | undefined;
  try {
    healthServer = serve({ fetch: healthApp.fetch, port: healthPort });
    console.log(JSON.stringify({ level: 'info', msg: 'health_server_started', port: healthPort }));
  } catch (err) {
    console.log(JSON.stringify({ level: 'warn', msg: 'health_server_failed', error: (err as Error).message }));
  }

  return {
    async close(): Promise<void> {
      healthServer?.close();
      conn.close();
    },
  };
}
