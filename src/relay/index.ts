import type { Connection } from '../network/index.js';
import { createServer } from '../network/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('relay');
import { initDatabase } from '../db.js';
import { verify, sign, sha256, toHex, fromHex } from '../crypto/index.js';
import { RateLimiter } from './rate_limiter.js';
import { MAX_REQUEST_AGE_MS } from '../config/bootstrap.js';
import type {
  WsMessage,
  ProviderHelloPayload,
  RequestPayload,
  ProviderInfo,
  StreamEndPayload,
} from '../types.js';
import type { Wallet } from '../wallet/index.js';
import type Database from 'better-sqlite3';

export interface RelayOptions {
  port: number;
  wallet: Wallet;
  dbPath: string;
  bootstrapUrl?: string;
}

interface ConnectedProvider {
  conn: Connection;
  info: ProviderInfo;
}

export function verifyRequest(
  outer: RequestPayload['outer'],
  requestId: string,
  timestamp: number,
  innerBase64: string,
): boolean {
  const now = Date.now();
  if (Math.abs(now - timestamp) > MAX_REQUEST_AGE_MS) {
    log.debug('verify_fail_timestamp', { now, timestamp, diff: Math.abs(now - timestamp) });
    return false;
  }

  const innerBytes = Buffer.from(innerBase64, 'base64');
  const innerHash = toHex(sha256(new Uint8Array(innerBytes)));

  const signable = JSON.stringify({
    request_id: requestId,
    consumer_pubkey: outer.consumer_pubkey,
    provider_id: outer.provider_id,
    model: outer.model,
    timestamp,
    inner_hash: innerHash,
  });

  const result = verify(
    new TextEncoder().encode(signable),
    fromHex(outer.signature),
    fromHex(outer.consumer_pubkey),
  );
  if (!result) {
    log.debug('verify_fail_signature', { consumer: outer.consumer_pubkey.slice(0, 16) });
  }
  return result;
}

export function createWitness(
  requestId: string,
  consumerPubkey: string,
  providerId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  relayWallet: Wallet,
): {
  request_id: string;
  consumer_hash: string;
  provider_id: string;
  relay_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  timestamp: number;
  relay_signature: string;
} {
  const dailySalt = new Date().toISOString().slice(0, 10);
  const consumerHash = toHex(
    sha256(new TextEncoder().encode(consumerPubkey + dailySalt)),
  );
  const relayId = toHex(relayWallet.signingPublicKey);
  const timestamp = Date.now();

  const witnessData = JSON.stringify({
    request_id: requestId,
    consumer_hash: consumerHash,
    provider_id: providerId,
    relay_id: relayId,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    timestamp,
  });

  const signature = sign(
    new TextEncoder().encode(witnessData),
    relayWallet.signingSecretKey,
  );

  return {
    request_id: requestId,
    consumer_hash: consumerHash,
    provider_id: providerId,
    relay_id: relayId,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    timestamp,
    relay_signature: toHex(signature),
  };
}

export async function startRelay(options: RelayOptions): Promise<{ close(): Promise<void> }> {
  const { port, wallet, dbPath, bootstrapUrl } = options;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  const db = initDatabase(dbPath);
  const providers = new Map<string, ConnectedProvider>();
  const consumers = new Map<string, Connection>(); // request_id -> consumer conn
  const requestMeta = new Map<string, { consumerPubkey: string; providerId: string; model: string }>();

  const rateLimiter = new RateLimiter(Number(process.env['VEIL_RELAY_RATE_LIMIT'] ?? 60));

  const insertWitness = db.prepare(`
    INSERT INTO witness (request_id, consumer_hash, provider_id, relay_id, model, input_tokens, output_tokens, timestamp, relay_signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertProvider = db.prepare(`
    INSERT INTO provider_state (provider_id, encryption_pubkey, models, capacity, connected_at, last_heartbeat, status)
    VALUES (?, ?, ?, ?, ?, ?, 'online')
    ON CONFLICT(provider_id) DO UPDATE SET
      encryption_pubkey = excluded.encryption_pubkey,
      models = excluded.models,
      capacity = excluded.capacity,
      last_heartbeat = excluded.last_heartbeat,
      status = 'online'
  `);

  const removeProvider = db.prepare(`
    UPDATE provider_state SET status = 'offline' WHERE provider_id = ?
  `);

  function handleProviderHello(conn: Connection, msg: WsMessage): void {
    const payload = msg.payload as ProviderHelloPayload;

    // Verify signature
    const signable = JSON.stringify({
      provider_pubkey: payload.provider_pubkey,
      encryption_pubkey: payload.encryption_pubkey,
      models: payload.models,
      capacity: payload.capacity,
      timestamp: msg.timestamp,
    });
    const valid = verify(
      new TextEncoder().encode(signable),
      fromHex(payload.signature),
      fromHex(payload.provider_pubkey),
    );

    if (!valid) {
      conn.send({
        type: 'provider_ack',
        payload: { status: 'rejected', reason: 'invalid_signature' },
        timestamp: Date.now(),
      });
      return;
    }

    const info: ProviderInfo = {
      provider_id: payload.provider_pubkey,
      encryption_pubkey: payload.encryption_pubkey,
      models: payload.models,
      capacity: payload.capacity,
    };

    providers.set(payload.provider_pubkey, { conn, info });
    const now = Date.now();
    upsertProvider.run(
      payload.provider_pubkey,
      payload.encryption_pubkey,
      JSON.stringify(payload.models),
      payload.capacity,
      now,
      now,
    );

    conn.send({
      type: 'provider_ack',
      payload: { status: 'accepted' },
      timestamp: Date.now(),
    });

    log.info('provider_registered', { id: payload.provider_pubkey.slice(0, 16) });
  }

  function handleConsumerRequest(conn: Connection, msg: WsMessage): void {
   try {
    const payload = msg.payload as RequestPayload;
    const requestId = msg.request_id!;

    // Verify signature
    if (!verifyRequest(payload.outer, requestId, msg.timestamp, payload.inner)) {
      conn.send({
        type: 'error',
        request_id: requestId,
        payload: { code: 'invalid_signature', message: 'Request signature verification failed' },
        timestamp: Date.now(),
      });
      return;
    }

    // Check rate limit
    const rateLimit = rateLimiter.tryAcquire(payload.outer.consumer_pubkey);
    if (!rateLimit.success) {
      conn.send({
        type: 'error',
        request_id: requestId,
        payload: { code: '429', message: `Rate limit exceeded. Retry-After: ${rateLimit.retryAfter}` },
        timestamp: Date.now(),
      });
      return;
    }

    // Find target provider
    const provider = providers.get(payload.outer.provider_id);
    if (!provider || provider.conn.readyState !== 'open') {
      conn.send({
        type: 'error',
        request_id: requestId,
        payload: { code: 'no_provider', message: 'Provider not available' },
        timestamp: Date.now(),
      });
      return;
    }

    // Store mapping for response routing
    consumers.set(requestId, conn);
    requestMeta.set(requestId, {
      consumerPubkey: payload.outer.consumer_pubkey,
      providerId: payload.outer.provider_id,
      model: payload.outer.model,
    });

    // Forward to provider with consumer_pubkey redacted
    const forwardMsg: WsMessage = {
      type: 'request',
      request_id: requestId,
      payload: {
        outer: {
          ...payload.outer,
          consumer_pubkey: 'redacted',
        },
        inner: payload.inner,
      },
      timestamp: msg.timestamp,
    };

    provider.conn.send(forwardMsg);
   } catch (err: any) {
    log.error('consumer_request_error', { error: err.message });
    const requestId = msg.request_id;
    if (requestId) {
      conn.send({ type: 'error', request_id: requestId, payload: { code: 'api_error', message: err.message }, timestamp: Date.now() });
    }
   }
  }

  function handleProviderResponse(msg: WsMessage): void {
    const requestId = msg.request_id!;
    const consumerConn = consumers.get(requestId);
    if (!consumerConn) return;

    consumerConn.send(msg);

    if (msg.type === 'response' || msg.type === 'stream_end') {
      const meta = requestMeta.get(requestId);
      if (meta) {
        const usage = msg.type === 'stream_end'
          ? (msg.payload as StreamEndPayload).usage
          : { input_tokens: 0, output_tokens: 0 };

        const witness = createWitness(
          requestId,
          meta.consumerPubkey,
          meta.providerId,
          meta.model,
          usage.input_tokens,
          usage.output_tokens,
          wallet,
        );

        try {
          insertWitness.run(
            witness.request_id,
            witness.consumer_hash,
            witness.provider_id,
            witness.relay_id,
            witness.model,
            witness.input_tokens,
            witness.output_tokens,
            witness.timestamp,
            witness.relay_signature,
          );
        } catch {
          // Duplicate request_id, ignore
        }
      }

      consumers.delete(requestId);
      requestMeta.delete(requestId);
    }
  }

  function handleListProviders(conn: Connection): void {
    const providerList = Array.from(providers.values()).map((p) => p.info);
    conn.send({
      type: 'provider_list',
      payload: { providers: providerList },
      timestamp: Date.now(),
    });
  }

  const server = createServer({
    port,
    onConnection(conn) {
      let isProvider = false;
      let providerId: string | null = null;

      conn.ws.on('message', (data) => {
        try {
          const msg: WsMessage = JSON.parse(data.toString());
          log.debug('relay_recv', { type: msg.type, req_id: msg.request_id?.slice(0, 8) });

          switch (msg.type) {
            case 'provider_hello':
              isProvider = true;
              providerId = (msg.payload as ProviderHelloPayload).provider_pubkey;
              handleProviderHello(conn, msg);
              break;

            case 'request':
              handleConsumerRequest(conn, msg);
              break;

            case 'response':
            case 'stream_start':
            case 'stream_chunk':
            case 'stream_end':
            case 'error':
              handleProviderResponse(msg);
              break;

            case 'list_providers':
              handleListProviders(conn);
              break;

            case 'ping':
              conn.send({ type: 'pong', payload: {}, timestamp: Date.now() });
              break;

            default:
              break;
          }
        } catch {
          log.error('relay_message_parse_error');
        }
      });

      conn.ws.on('close', () => {
        if (isProvider && providerId) {
          providers.delete(providerId);
          try { removeProvider.run(providerId); } catch { /* db may be closed */ }
          log.info('provider_disconnected', { id: providerId.slice(0, 16) });
        }
      });
    },
  });

  log.info('relay_started', { port: server.port });

  // Bootstrap registration
  if (bootstrapUrl) {
    const relayPubkey = toHex(wallet.signingPublicKey);
    const relayEndpoint = `wss://0.0.0.0:${server.port}`;

    const registerPayload = {
      relay_pubkey: relayPubkey,
      relay_id: relayPubkey.slice(0, 16),
      endpoint: relayEndpoint,
      models_supported: Object.keys(await import('../config/bootstrap.js').then(m => m.MODEL_MAP)),
      fee_pct: 0,
      region: process.env['VEIL_RELAY_REGION'] ?? 'unknown',
      capacity: 100,
      version: '0.1.0',
    };

    async function registerWithBootstrap(): Promise<void> {
      try {
        const ts = Date.now();
        const signable = JSON.stringify({ ...registerPayload, timestamp: ts });
        const sig = sign(new TextEncoder().encode(signable), wallet.signingSecretKey);

        const res = await fetch(`${bootstrapUrl}/v1/relays/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...registerPayload,
            timestamp: ts,
            signature: toHex(sig),
          }),
        });
        if (!res.ok) {
          log.warn('bootstrap_register_failed', { status: res.status });
        } else {
          log.info('bootstrap_registered');
        }
      } catch (err) {
        log.warn('bootstrap_register_error', { error: (err as Error).message });
      }
    }

    // Initial registration
    await registerWithBootstrap();

    // Heartbeat every 30s
    heartbeatInterval = setInterval(() => {
      registerWithBootstrap().catch(() => {});
    }, 30_000);
  }

  return {
    async close(): Promise<void> {
      if (heartbeatInterval) clearInterval(heartbeatInterval);

      // Deregister from bootstrap
      if (bootstrapUrl) {
        const relayPubkey = toHex(wallet.signingPublicKey);
        try {
          await fetch(`${bootstrapUrl}/v1/relays/${relayPubkey}`, { method: 'DELETE' });
          log.info('bootstrap_deregistered');
        } catch {
          // Best effort
        }
      }

      server.close();
      db.close();
    },
  };
}
