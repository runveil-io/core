import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createLogger } from '../logger.js';

const log = createLogger('consumer');
import { nanoid } from 'nanoid';
import { connect } from '../network/index.js';
import { seal, open, sign, sha256, toHex, fromHex } from '../crypto/index.js';
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
import type { RelayDiscoveryClient } from '../discovery/client.js';

export interface GatewayOptions {
  port: number;
  wallet: Wallet;
  relayUrl: string;
  apiKey?: string;
  discoveryClient?: RelayDiscoveryClient;
}

const startTime = Date.now();

function errorResponse(message: string, type: string, code: string | null, status: number): Response {
  const body: ErrorResponse = { error: { message, type, code } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  let currentRelayUrl = relayUrl;
  const excludedRelays: string[] = [];

  async function resolveRelayUrl(): Promise<string> {
    if (!options.discoveryClient) return relayUrl;
    try {
      const selected = await options.discoveryClient.selectRelay(excludedRelays);
      if (selected) {
        log.info('discovery_selected_relay', {
          relay: selected.relay.relay_id,
          endpoint: selected.relay.endpoint,
          score: selected.score.toFixed(1),
        });
        return selected.relay.endpoint;
      }
    } catch (err) {
      log.warn('discovery_failed_fallback', { error: (err as Error).message });
    }
    return relayUrl; // fallback
  }

  async function connectRelay(): Promise<void> {
    try {
      currentRelayUrl = await resolveRelayUrl();
      relayConn = await connect({
        url: currentRelayUrl,
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
          log.warn('relay_disconnected');
          if (options.discoveryClient) {
            // Try to failover to a different relay
            excludedRelays.push(currentRelayUrl);
            log.info('discovery_failover', { excluded: excludedRelays.length });
            // Reconnect will be handled by the reconnect option
          }
        },
        onError(err) {
          log.error('relay_error', { error: err.message });
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
      log.error('relay_connect_failed', { error: (err as Error).message });
    }
  }

  function selectProvider(model: string, excludeIds: string[] = []): ProviderInfo | null {
    const available = providers.filter(
      (p) => p.models.includes(model) && p.capacity > 0 && !excludeIds.includes(p.provider_id)
    );
    if (available.length > 0) return available[0]!;
    // Fallback: If we exhausted all and need to retry, just pick any available ignoring exclusions
    const anyAvailable = providers.filter((p) => p.models.includes(model) && p.capacity > 0);
    if (anyAvailable.length > 0) {
      return anyAvailable[Math.floor(Math.random() * anyAvailable.length)]!;
    }
    return null;
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

    if (body.stream) {
      // Streaming response
      const created = Math.floor(Date.now() / 1000);
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let sentRole = false;
          let attempts = 0;
          const excludeIds: string[] = [];
          let midStream = false;

          while (attempts <= 3) {
            const provider = selectProvider(body.model, excludeIds);
            if (!provider) {
               const errChunk = makeChunk('veil-error', body.model, created, {}, null);
               controller.enqueue(encoder.encode(errChunk));
               controller.enqueue(encoder.encode(makeDone()));
               controller.close();
               break;
            }

            const requestId = 'veil-' + nanoid(24);
            let wsMsg: WsMessage;
            try {
              wsMsg = buildRequest(requestId, body, provider);
            } catch (err: any) {
               controller.close();
               break;
            }

            try {
              await new Promise<void>((resolve, reject) => {
                const pending = {
                  resolve: (_value: unknown) => {
                    resolve();
                  },
                  reject: (err: Error) => {
                    reject(err);
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

                      midStream = true;

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
                      resolve();
                    }
                  },
                };

                pendingRequests.set(requestId, pending);
                relayConn!.send(wsMsg);
              });

              // Request completed successfully
              controller.enqueue(encoder.encode(makeDone()));
              controller.close();
              return;

            } catch (err: any) {
              const msg = err.message;
              if (midStream || msg.includes('invalid_request') || msg.includes('rate_limit') || msg.includes('invalid_signature') || msg.includes('decrypt_failed') || attempts === 3) {
                 const errChunk = makeChunk(requestId, body.model, created, {}, null);
                 controller.enqueue(encoder.encode(errChunk));
                 controller.enqueue(encoder.encode(makeDone()));
                 controller.close();
                 return;
              }

              excludeIds.push(provider.provider_id);
              attempts++;
              await sleep((1 << (attempts - 1)) * 1000); // 1s, 2s, 4s
            }
          }
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
      return new Promise<Response>(async (httpResolve) => {
        let attempts = 0;
        const excludeIds: string[] = [];

        while (attempts <= 3) {
          const provider = selectProvider(body.model, excludeIds);
          if (!provider) {
            if (attempts === 0) {
              return httpResolve(errorResponse('No providers available', 'api_error', 'no_providers', 503));
            }
            break; // give up and throw error below
          }

          const requestId = 'veil-' + nanoid(24);
          let wsMsg: WsMessage;
          try {
            wsMsg = buildRequest(requestId, body, provider);
          } catch (err: any) {
             return httpResolve(errorResponse('Failed to build request: ' + err.message, 'api_error', null, 500));
          }

          try {
            const resp = await new Promise<Response>((resolve, reject) => {
              const timeout = setTimeout(() => {
                pendingRequests.delete(requestId);
                reject(new Error('timeout:Request timeout'));
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
                    reject(new Error('decrypt_failed:Failed to decrypt response'));
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

                  resolve(new Response(JSON.stringify(response), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                  }));
                },
                reject: (err) => {
                  clearTimeout(timeout);
                  reject(err);
                },
              });

              relayConn!.send(wsMsg);
            });
            
            return httpResolve(resp);
          } catch (err: any) {
            const msg = err.message;
            if (msg.includes('invalid_request') || msg.includes('rate_limit') || msg.includes('invalid_signature') || msg.includes('decrypt_failed') || attempts === 3) {
              if (msg.includes('no_provider') || msg.includes('no_providers')) {
                return httpResolve(errorResponse('No providers available', 'api_error', 'no_providers', 503));
              } else if (msg.includes('rate_limit')) {
                return httpResolve(errorResponse('Rate limit exceeded', 'api_error', 'rate_limit', 429));
              } else if (msg.includes('timeout')) {
                return httpResolve(errorResponse('Request timeout', 'api_error', 'timeout', 504));
              } else {
                return httpResolve(errorResponse('Internal error: ' + msg, 'api_error', null, 500));
              }
            }
            
            excludeIds.push(provider.provider_id);
            attempts++;
            await sleep((1 << (attempts - 1)) * 1000); // 1s, 2s, 4s
          }
        }
      });
    }
  });

  // Connect to relay
  await connectRelay();

  const server = serve({ fetch: app.fetch, port });

  log.info('gateway_started', { port });

  return {
    async close(): Promise<void> {
      server.close();
      relayConn?.close();
    },
    port,
  };
}
