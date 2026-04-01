import { connect } from '../network/index.js';
import { open, seal, sign, toHex, fromHex } from '../crypto/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('provider');
import { MODEL_MAP, RETRY_CONFIG } from '../config/bootstrap.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { MetricsStore } from './metrics.js';
import type { Connection } from '../network/index.js';
import type { Wallet } from '../wallet/index.js';
import type {
  WsMessage,
  RequestPayload,
  InnerPlaintext,
  StreamChunkPayload,
} from '../types.js';
import type { RelayDiscoveryClient } from '../discovery/client.js';

const PROVIDER_VERSION = '0.1.0';
const DEFAULT_HEALTH_PORT = 9962;
const MULTI_RELAY_COUNT = 3;

export interface ProviderOptions {
  wallet: Wallet;
  relayUrl: string;
  apiKeys: Array<{ provider: 'anthropic'; key: string }>;
  maxConcurrent: number;
  proxyUrl?: string;      // e.g. http://127.0.0.1:4000
  proxySecret?: string;   // shared secret for proxy auth
  healthPort?: number;    // port for /health endpoint (default 9962)
  discoveryClient?: RelayDiscoveryClient;
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
  signal?: AbortSignal,
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
    headers['x-api-key'] = apiKey;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(anthropicRequest),
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    log.error('anthropic_error', { status: res.status, body: errorText });
    if (res.status === 401) throw new Error('upstream_auth:Unauthorized');
    throw new Error(`anthropic_${res.status}:${errorText}`);
  }

  if (inner.stream) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = 'stop';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') break;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'content_block_delta' && parsed.delta.type === 'text_delta') {
                const text = parsed.delta.text;
                content += text;
                onChunk?.(text);
              } else if (parsed.type === 'message_start') {
                inputTokens = parsed.message.usage.input_tokens;
              } else if (parsed.type === 'message_delta') {
                outputTokens = parsed.usage.output_tokens;
                if (parsed.delta.finish_reason) {
                   finishReason = parsed.delta.finish_reason;
                }
              }
            } catch {
              // Ignore partial JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      finish_reason: finishReason,
    };
  } else {
    const result = await res.json() as any;
    return {
      content: result.content[0].text,
      usage: {
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
      },
      finish_reason: result.stop_reason,
    };
  }
}

export async function startProvider(options: ProviderOptions): Promise<{ close(): Promise<void> }> {
  const { wallet, relayUrl, apiKeys, maxConcurrent, proxyUrl, proxySecret } = options;
  let activeRequests = 0;
  const metrics = new MetricsStore();
  const activeControllers = new Map<string, AbortController>();

  const conn = await connect({
    url: relayUrl,
    onMessage(msg: WsMessage) {
      log.debug('provider_recv', { type: msg.type, req_id: msg.request_id?.slice(0, 8) });

      switch (msg.type) {
        case 'provider_ack':
          log.info('provider_ack', msg.payload);
          break;

        case 'request':
          handleProviderRequest(conn, msg).catch((err) => {
            log.error('handle_request_fatal', { error: err.message });
          });
          break;
        
        case 'cancel':
          if (msg.request_id) {
            const controller = activeControllers.get(msg.request_id);
            if (controller) {
              controller.abort();
              activeControllers.delete(msg.request_id);
              log.info('provider_cancel_handled', { req_id: msg.request_id.slice(0, 8) });
            }
          }
          break;

        case 'pong':
          break;

        default:
          break;
      }
    },
    reconnect: true,
  });

  const extraConnections: Connection[] = [];
  if (options.discoveryClient) {
    const relays = await options.discoveryClient.selectRelay([], MULTI_RELAY_COUNT);
    for (const r of relays) {
      if (r.relay.endpoint === relayUrl) continue;
      try {
        const ec = await connect({
          url: r.relay.endpoint,
          onMessage(msg: WsMessage) {
            if (msg.type === 'request') {
              handleProviderRequest(ec, msg).catch(() => {});
            } else if (msg.type === 'cancel') {
              if (msg.request_id) {
                 activeControllers.get(msg.request_id)?.abort();
                 activeControllers.delete(msg.request_id);
              }
            }
          },
          reconnect: true,
        });
        extraConnections.push(ec);
        log.info('multi_relay_connected', { url: r.relay.endpoint });
      } catch (err) {
        log.warn('multi_relay_connect_failed', { url: r.relay.endpoint, error: (err as Error).message });
      }
    }
  }

  // Initial hello
  function sendHello(c: Connection) {
    c.send({
      type: 'provider_hello',
      payload: {
        provider_pubkey: toHex(wallet.signingPublicKey),
        encryption_pubkey: toHex(wallet.encryptionPublicKey),
        models: Object.keys(MODEL_MAP),
        capacity: maxConcurrent,
        signature: toHex(
          sign(
            new TextEncoder().encode(
              JSON.stringify({
                provider_pubkey: toHex(wallet.signingPublicKey),
                encryption_pubkey: toHex(wallet.encryptionPublicKey),
                models: Object.keys(MODEL_MAP),
                capacity: maxConcurrent,
                timestamp: Date.now(),
              }),
            ),
            wallet.signingSecretKey,
          ),
        ),
      },
      timestamp: Date.now(),
    });
  }

  sendHello(conn);
  for (const ec of extraConnections) sendHello(ec);

  async function handleProviderRequest(conn: Connection, msg: WsMessage): Promise<void> {
    const requestId = msg.request_id!;
    const payload = msg.payload as RequestPayload;
    const requestStart = Date.now();
    let isError = false;
    let modelName = 'unknown';

    if (activeRequests >= maxConcurrent) {
      conn.send({
        type: 'error',
        request_id: requestId,
        payload: { code: 'rate_limit', message: 'Provider at capacity' },
        timestamp: Date.now(),
      });
      return;
    }

    activeRequests++;
    const controller = new AbortController();
    activeControllers.set(requestId, controller);

    try {
      const decrypted = open(
        new Uint8Array(Buffer.from(payload.inner, 'base64')),
        wallet.encryptionSecretKey,
      );
      if (!decrypted) throw new Error('decrypt_failed');

      const inner = JSON.parse(new TextDecoder().decode(decrypted)) as InnerPlaintext;
      modelName = inner.model;
      const consumerEncPubkey = fromHex(payload.outer.encryption_pubkey);

      const apiKey = apiKeys.find((k) => k.provider === 'anthropic')?.key;
      const apiBase = proxyUrl;

      if (inner.stream) {
        // Send stream_start
        conn.send({
          type: 'stream_start',
          request_id: requestId,
          payload: { model: inner.model },
          timestamp: Date.now(),
        });

        let chunkIndex = 0;
        const result = await handleRequest(inner, apiKey!, (chunk) => {
          const sealedChunk = seal(
            new TextEncoder().encode(chunk),
            new Uint8Array(consumerEncPubkey),
            wallet.encryptionSecretKey,
          );
          conn.send({
            type: 'stream_chunk',
            request_id: requestId,
            payload: {
              encrypted_chunk: Buffer.from(sealedChunk).toString('base64'),
              index: chunkIndex++,
            } satisfies StreamChunkPayload,
            timestamp: Date.now(),
          });
        }, apiBase, proxySecret, controller.signal);

        // Final chunk for finish_reason
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
        const result = await handleRequest(inner, apiKey!, undefined, apiBase, proxySecret, controller.signal);
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
    } catch (err: any) {
      if (err.name === 'AbortError') {
        log.info('request_abort_confirmed', { req_id: requestId.slice(0, 8) });
        return; // No need to send error back if it was explicitly cancelled
      }
      isError = true;
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
      activeControllers.delete(requestId);
      const latencyMs = Date.now() - requestStart;
      metrics.recordRequest(modelName, latencyMs, isError);
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

  healthApp.get('/metrics', (c) => {
    return c.json(metrics.getMetrics());
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
      for (const ec of extraConnections) {
        ec.close();
      }
      conn.close();
    },
  };
}
