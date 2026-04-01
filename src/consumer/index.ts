import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { nanoid } from 'nanoid';
import { connect } from '../network/index.js';
import { seal, open, sign, sha256, toHex, fromHex } from '../crypto/index.js';
import { Logger } from '../logger.js';
import { MODELS, MODEL_MAP } from '../config/bootstrap.js';
import { makeChunk, makeDone } from './anthropic-stream.js';
import type { Connection } from '../network/index.js';
import type { Wallet } from '../wallet/index.js';
import type {
  WsMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ErrorResponse,
  ProviderInfo,
  RequestPayload,
  ResponsePayload,
  StreamChunkPayload,
  StreamEndPayload,
  InnerPlaintext,
  ErrorPayload,
  ProviderListPayload,
} from '../types.js';

export interface GatewayOptions {
  port: number;
  wallet: Wallet;
  relayUrl: string;
  apiKey?: string;
}

const logger = new Logger('consumer_gateway');
const startTime = Date.now();

function errorResponse(message: string, type: string, code: string | null, status: number): Response {
  const body: ErrorResponse = { error: { message, type, code } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function startGateway(options: GatewayOptions): Promise<{
  close(): Promise<void>;
  port: number;
}> {
  const { port, wallet, relayUrl, apiKey } = options;
  let providers: ProviderInfo[] = [];
  let relayConnected = false;

  // Pending request handlers
  const pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    onChunk?: (msg: WsMessage) => void;
  }>();

  let relayConn: Connection | null = null;

  async function connectRelay(): Promise<void> {
    try {
      relayConn = await connect({
        url: relayUrl,
        onMessage(msg: WsMessage) {
          if (msg.type === 'provider_list') {
            providers = (msg.payload as ProviderListPayload).providers;
            return;
          }

          if (msg.type === 'pong') return;

          const requestId = msg.request_id;
          if (!requestId) return;

          const pending = pendingRequests.get(requestId);
          if (!pending) return;

          if (msg.type === 'response') {
            pending.resolve(msg);
            pendingRequests.delete(requestId);
          } else if (msg.type === 'stream_start' || msg.type === 'stream_chunk') {
            pending.onChunk?.(msg);
          } else if (msg.type === 'stream_end') {
            pending.onChunk?.(msg);
            pending.resolve(msg);
            pendingRequests.delete(requestId);
          } else if (msg.type === 'error') {
            const payload = msg.payload as ErrorPayload;
            pending.reject(new Error(payload.code + ':' + payload.message));
            pendingRequests.delete(requestId);
          }
        },
        onClose() {
          relayConnected = false;
          logger.warn('relay_disconnected');
        },
        onError(err) {
          logger.error('relay_error', { error: err.message });
        },
        reconnect: true,
      });

      relayConnected = true;

      // Request provider list
      relayConn.send({
        type: 'list_providers',
        payload: {},
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.error('relay_connect_failed', { error: (err as Error).message });
    }
  }

  function selectProvider(model: string): ProviderInfo | null {
    const available = providers.filter(
      (p) => p.models.includes(model) && p.capacity > 0,
    );
    if (available.length === 0) return null;
    // Simple: pick first available
    return available[0]!;
  }

  function buildRequest(
    requestId: string,
    req: ChatCompletionRequest,
    provider: ProviderInfo,
  ): WsMessage {
    const inner: InnerPlaintext = {
      messages: req.messages,
      model: req.model,
      max_tokens: req.max_tokens ?? 4096,
      temperature: req.temperature ?? 1,
      top_p: req.top_p ?? 1,
      stop_sequences: req.stop
        ? Array.isArray(req.stop) ? req.stop : [req.stop]
        : [],
      stream: req.stream ?? false,
    };

    const plaintext = new TextEncoder().encode(JSON.stringify(inner));
    const sealed = seal(plaintext, fromHex(provider.encryption_pubkey), wallet.encryptionSecretKey);
    const innerBase64 = Buffer.from(sealed).toString('base64');
    const innerHash = toHex(sha256(sealed));

    const timestamp = Date.now();
    const consumerPubkey = toHex(wallet.signingPublicKey);

    const signable = JSON.stringify({
      request_id: requestId,
      consumer_pubkey: consumerPubkey,
      provider_id: provider.provider_id,
      model: req.model,
      timestamp,
      inner_hash: innerHash,
    });

    const signature = sign(new TextEncoder().encode(signable), wallet.signingSecretKey);

    const payload: RequestPayload = {
      outer: {
        consumer_pubkey: consumerPubkey,
        provider_id: provider.provider_id,
        model: req.model,
        signature: toHex(signature),
      },
      inner: innerBase64,
    };

    return {
      type: 'request',
      request_id: requestId,
      payload,
      timestamp,
    };
  }

  const app = new Hono();

  // Auth middleware for /v1/*
  app.use('/v1/*', async (c, next) => {
    if (apiKey) {
      const auth = c.req.header('authorization');
      if (!auth || !auth.startsWith('Bearer ')) {
        return c.json(
          { error: { message: 'Missing API key', type: 'authentication_error', code: null } },
          401,
        );
      }
      const token = auth.slice(7);
      if (!constantTimeCompare(token, apiKey)) {
        return c.json(
          { error: { message: 'Invalid API key', type: 'authentication_error', code: null } },
          401,
        );
      }
    }
    await next();
  });

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      version: '0.1.0',
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      providers_online: providers.length,
      relay_connected: relayConnected,
    });
  });

  app.get('/v1/models', (c) => {
    return c.json({
      object: 'list' as const,
      data: MODELS.map((m) => ({
        id: m.id,
        object: 'model' as const,
        created: m.created,
        owned_by: 'veil' as const,
      })),
    });
  });

  app.post('/v1/chat/completions', async (c) => {
    let body: ChatCompletionRequest;
    try {
      body = await c.req.json<ChatCompletionRequest>();
    } catch {
      return errorResponse('Invalid JSON body', 'invalid_request_error', null, 400);
    }

    if (!body.model) {
      return errorResponse('model is required', 'invalid_request_error', null, 400);
    }
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return errorResponse('messages is required and must be non-empty', 'invalid_request_error', null, 400);
    }

    const modelExists = MODELS.some((m) => m.id === body.model);
    if (!modelExists) {
      return errorResponse(`Model '${body.model}' not available`, 'invalid_request_error', 'model_not_found', 404);
    }

    if (!relayConn || relayConn.readyState !== 'open') {
      return errorResponse('Relay not connected', 'api_error', null, 502);
    }

    const provider = selectProvider(body.model);
    if (!provider) {
      return errorResponse('No providers available', 'api_error', 'no_providers', 503);
    }

    const requestId = 'veil-' + nanoid(24);
    let wsMsg: WsMessage;
    try {
      wsMsg = buildRequest(requestId, body, provider);
    } catch (err: any) {
      logger.error('build_request_failed', { error: err.message, stack: err.stack?.split('\n').slice(0, 3) });
      return errorResponse('Failed to build request: ' + err.message, 'api_error', null, 500);
    }

    if (body.stream) {
      // Streaming response
      const created = Math.floor(Date.now() / 1000);
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          let sentRole = false;

          const pending = {
            resolve: (_value: unknown) => {
              controller.close();
            },
            reject: (err: Error) => {
              const errChunk = makeChunk(requestId, body.model, created, {}, null);
              controller.enqueue(encoder.encode(errChunk));
              controller.enqueue(encoder.encode(makeDone()));
              controller.close();
            },
            onChunk: (msg: WsMessage) => {
              if (msg.type === 'stream_chunk') {
                const payload = msg.payload as StreamChunkPayload;
                const decrypted = open(
                  new Uint8Array(Buffer.from(payload.encrypted_chunk, 'base64')),
                  wallet.encryptionSecretKey,
                );
                if (!decrypted) return;
                const text = new TextDecoder().decode(decrypted);

                try {
                  const parsed = JSON.parse(text) as { role?: string; content?: string; finish_reason?: string };
                  if (parsed.role && !sentRole) {
                    sentRole = true;
                    controller.enqueue(
                      encoder.encode(makeChunk(requestId, body.model, created, { role: parsed.role }, null)),
                    );
                  } else if (parsed.finish_reason) {
                    controller.enqueue(
                      encoder.encode(makeChunk(requestId, body.model, created, {}, parsed.finish_reason)),
                    );
                  } else {
                    // Plain text content
                    controller.enqueue(
                      encoder.encode(makeChunk(requestId, body.model, created, { content: text }, null)),
                    );
                  }
                } catch {
                  // Plain text content
                  controller.enqueue(
                    encoder.encode(makeChunk(requestId, body.model, created, { content: text }, null)),
                  );
                }
              } else if (msg.type === 'stream_end') {
                controller.enqueue(encoder.encode(makeDone()));
              }
            },
          };

          pendingRequests.set(requestId, pending);
          relayConn!.send(wsMsg);
        },
      });

      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        },
      });
    } else {
      // Non-streaming response
      return new Promise<Response>((httpResolve) => {
        const timeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          httpResolve(errorResponse('Request timeout', 'api_error', 'timeout', 504));
        }, Number(process.env['VEIL_REQUEST_TIMEOUT'] ?? 120000));

        pendingRequests.set(requestId, {
          resolve: (value) => {
            clearTimeout(timeout);
            const msg = value as WsMessage;
            const payload = msg.payload as ResponsePayload;

            const decrypted = open(
              new Uint8Array(Buffer.from(payload.encrypted_body, 'base64')),
              wallet.encryptionSecretKey,
            );
            if (!decrypted) {
              httpResolve(errorResponse('Failed to decrypt response', 'api_error', 'decrypt_failed', 500));
              return;
            }

            const result = JSON.parse(new TextDecoder().decode(decrypted)) as {
              content: string;
              usage: { input_tokens: number; output_tokens: number };
              finish_reason: string;
            };

            const response: ChatCompletionResponse = {
              id: requestId,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{
                index: 0,
                message: { role: 'assistant', content: result.content },
                finish_reason: result.finish_reason as 'stop' | 'length',
              }],
              usage: {
                prompt_tokens: result.usage.input_tokens,
                completion_tokens: result.usage.output_tokens,
                total_tokens: result.usage.input_tokens + result.usage.output_tokens,
              },
            };

            httpResolve(new Response(JSON.stringify(response), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }));
          },
          reject: (err) => {
            clearTimeout(timeout);
            const msg = err.message;
            if (msg.includes('no_provider')) {
              httpResolve(errorResponse('No providers available', 'api_error', 'no_providers', 503));
            } else if (msg.includes('rate_limit')) {
              httpResolve(errorResponse('Rate limit exceeded', 'api_error', 'rate_limit', 429));
            } else {
              logger.error('request_rejected', { error: msg });
              httpResolve(errorResponse('Internal error: ' + msg, 'api_error', null, 500));
            }
          },
        });

        relayConn!.send(wsMsg);
      });
    }
  });

  // Connect to relay
  await connectRelay();

  const server = serve({ fetch: app.fetch, port });

  logger.info('gateway_started', { port });

  return {
    async close(): Promise<void> {
      server.close();
      relayConn?.close();
    },
    port,
  };
}
