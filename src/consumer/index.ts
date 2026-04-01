import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { nanoid } from 'nanoid';
import { connect } from '../network/index.js';
import { seal, open, sign, sha256, toHex, fromHex } from '../crypto/index.js';
import { MODELS, MODEL_MAP } from '../config/bootstrap.js';
import { makeChunk, makeDone } from './anthropic-stream.js';
import { ProviderSelector } from './selector.js';
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
  const selector = new ProviderSelector();

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
            selector.updateProviders(providers);
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
          console.log(JSON.stringify({ level: 'warn', msg: 'relay_disconnected' }));
        },
        onError(err) {
          console.log(JSON.stringify({ level: 'error', msg: 'relay_error', error: err.message }));
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
      console.log(JSON.stringify({ level: 'error', msg: 'relay_connect_failed', error: (err as Error).message }));
    }
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

  async function sendWithFallback(
    requestId: string,
    body: ChatCompletionRequest,
    onChunk?: (msg: WsMessage) => void,
  ): Promise<WsMessage> {
    let lastError: Error | null = null;
    const triedProviders = new Set<string>();

    while (true) {
      const provider = selector.selectProvider(body.model, triedProviders);
      if (!provider) {
        throw lastError ?? new Error('no_provider:No providers available');
      }

      triedProviders.add(provider.provider_id);

      let wsMsg: WsMessage;
      try {
        wsMsg = buildRequest(requestId, body, provider);
      } catch (err: any) {
        selector.rotateOnError(provider.provider_id);
        lastError = err;
        continue;
      }

      try {
        const result = await new Promise<WsMessage>((resolve, reject) => {
          const timeout = setTimeout(() => {
            pendingRequests.delete(requestId);
            reject(new Error('timeout:Request timeout'));
          }, Number(process.env['VEIL_REQUEST_TIMEOUT'] ?? 120000));

          pendingRequests.set(requestId, {
            resolve: (value) => {
              clearTimeout(timeout);
              resolve(value as WsMessage);
            },
            reject: (err) => {
              clearTimeout(timeout);
              reject(err);
            },
            onChunk,
          });

          relayConn!.send(wsMsg);
        });

        selector.recordSuccess(provider.provider_id);
        return result;
      } catch (err: any) {
        pendingRequests.delete(requestId);
        selector.rotateOnError(provider.provider_id);
        lastError = err;

        const msg: string = err.message ?? '';
        if (msg.includes('rate_limit') || msg.includes('no_provider') || msg.includes('timeout')) {
          continue;
        }
        continue;
      }
    }
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

    const initialProvider = selector.selectProvider(body.model);
    if (!initialProvider) {
      return errorResponse('No providers available', 'api_error', 'no_providers', 503);
    }

    const requestId = 'veil-' + nanoid(24);

    if (body.stream) {
      const created = Math.floor(Date.now() / 1000);
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          let sentRole = false;

          const onChunk = (msg: WsMessage) => {
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
                  controller.enqueue(
                    encoder.encode(makeChunk(requestId, body.model, created, { content: text }, null)),
                  );
                }
              } catch {
                controller.enqueue(
                  encoder.encode(makeChunk(requestId, body.model, created, { content: text }, null)),
                );
              }
            } else if (msg.type === 'stream_end') {
              controller.enqueue(encoder.encode(makeDone()));
            }
          };

          sendWithFallback(requestId, body, onChunk)
            .then(() => {
              controller.close();
            })
            .catch((err: Error) => {
              const errChunk = makeChunk(requestId, body.model, created, {}, null);
              controller.enqueue(encoder.encode(errChunk));
              controller.enqueue(encoder.encode(makeDone()));
              controller.close();
            });
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
      try {
        const msg = await sendWithFallback(requestId, body);
        const payload = msg.payload as ResponsePayload;

        const decrypted = open(
          new Uint8Array(Buffer.from(payload.encrypted_body, 'base64')),
          wallet.encryptionSecretKey,
        );
        if (!decrypted) {
          return errorResponse('Failed to decrypt response', 'api_error', 'decrypt_failed', 500);
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

        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err: any) {
        const msg: string = err.message ?? '';
        if (msg.includes('no_provider')) {
          return errorResponse('No providers available', 'api_error', 'no_providers', 503);
        } else if (msg.includes('rate_limit')) {
          return errorResponse('Rate limit exceeded', 'api_error', 'rate_limit', 429);
        } else if (msg.includes('timeout')) {
          return errorResponse('Request timeout', 'api_error', 'timeout', 504);
        } else {
          console.log(JSON.stringify({ level: '