import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { startRelay } from '../src/relay/index.js';
import { startProvider } from '../src/provider/index.js';
import { startGateway } from '../src/consumer/index.js';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
} from '../src/crypto/index.js';
import type { Wallet } from '../src/wallet/index.js';

describe('e2e', () => {
  let tempDir: string;
  let mockAnthropicServer: ReturnType<typeof serve>;
  let mockAnthropicPort: number;
  let relayHandle: { close(): Promise<void> };
  let providerHandle: { close(): Promise<void> };
  let gatewayHandle: { close(): Promise<void>; port: number };
  let relayPort: number;
  let gatewayPort: number;

  function makeWallet(): Wallet {
    const signing = generateSigningKeyPair();
    const encryption = generateEncryptionKeyPair();
    return {
      signingPublicKey: signing.publicKey,
      signingSecretKey: signing.secretKey,
      encryptionPublicKey: encryption.publicKey,
      encryptionSecretKey: encryption.secretKey,
    };
  }

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'veil-e2e-'));

    // 1. Mock Anthropic API
    const anthropicApp = new Hono();
    anthropicApp.post('/v1/messages', async (c) => {
      const body = await c.req.json();

      if (body.stream) {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_e2e","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":15,"output_tokens":1}}}\n\n'));
            controller.enqueue(enc.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
            controller.enqueue(enc.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"E2E"}}\n\n'));
            controller.enqueue(enc.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" works!"}}\n\n'));
            controller.enqueue(enc.encode('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'));
            controller.enqueue(enc.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n'));
            controller.enqueue(enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }

      return c.json({
        id: 'msg_e2e',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'E2E works!' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        usage: { input_tokens: 15, output_tokens: 3 },
      });
    });

    mockAnthropicServer = serve({ fetch: anthropicApp.fetch, port: 0 });
    mockAnthropicPort = (mockAnthropicServer as any).address().port;

    // 2. Start Relay
    const relayWallet = makeWallet();
    relayHandle = await startRelay({
      port: 0,
      wallet: relayWallet,
      dbPath: join(tempDir, 'e2e-relay.db'),
    });
    relayPort = (relayHandle as any).port;

    // 3. Start Provider (connects to Relay, uses mock Anthropic)
    const providerWallet = makeWallet();

    // We need to patch ANTHROPIC_API_KEY and base URL for the provider
    // Since handleRequest takes apiBase param, we need to inject it.
    // For e2e, we'll set env variable approach.
    process.env['MOCK_ANTHROPIC_PORT'] = String(mockAnthropicPort);

    providerHandle = await startProvider({
      wallet: providerWallet,
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      apiKeys: [{ provider: 'anthropic', key: 'test-key' }],
      maxConcurrent: 5,
      healthPort: 0,
      proxyUrl: `http://127.0.0.1:${mockAnthropicPort}`,
    });

    // Wait for provider registration
    await new Promise((r) => setTimeout(r, 500));

    // 4. Start Consumer Gateway (connects to Relay)
    const consumerWallet = makeWallet();
    gatewayHandle = await startGateway({
      port: 0,
      wallet: consumerWallet,
      relayUrl: `ws://127.0.0.1:${relayPort}`,
    });
    gatewayPort = gatewayHandle.port;

    // Wait for consumer to get provider list
    await new Promise((r) => setTimeout(r, 500));
  }, 15000);

  afterAll(async () => {
    await gatewayHandle?.close();
    await providerHandle?.close();
    await relayHandle?.close();
    mockAnthropicServer?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('full flow: Consumer HTTP -> Relay -> Provider -> response', async () => {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });
    const textContext = await res.clone().text();
    console.log('body is', textContext);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.choices[0].message.content).toBe('E2E works!');
  });

  it('full streaming flow', async () => {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'test' }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);

    if (res.status === 200) {
      const text = await res.text();
      // Should contain SSE data
      expect(text).toContain('data:');
    }
  });

  it('first token latency < 2000ms over 127.0.0.1', async () => {
    const start = Date.now();
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });

    if (res.status === 200 && res.body) {
      const reader = res.body.getReader();
      const { value } = await reader.read();
      const firstTokenTime = Date.now() - start;
      reader.cancel();
      expect(firstTokenTime).toBeLessThan(2000);
    } else {
      expect(res.status).toBe(200);
    }
  });

  it('Auth failure: bad signing key rejected by relay', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relayPort}`);
      ws.on('open', () => {
        const msg = {
          type: 'request',
          request_id: 'bad-request-1',
          payload: {
            outer: {
              consumer_pubkey: 'A'.repeat(64),
              provider_id: 'B'.repeat(64),
              model: 'claude-sonnet-4-20250514',
              signature: 'C'.repeat(128)
            },
            inner: 'ABCD'
          },
          timestamp: Date.now()
        };
        ws.send(JSON.stringify(msg));
      });

      ws.on('message', (data) => {
        const resp = JSON.parse(data.toString());
        if (resp.type === 'error' && resp.payload?.code === 'invalid_signature') {
          ws.close();
          resolve();
        } else {
          ws.close();
          reject(new Error('Expected invalid_signature error, got: ' + JSON.stringify(resp)));
        }
      });

      ws.on('error', reject);
    });
  });

  it('Encryption verification: relay never sees plaintext prompt', async () => {
    // We send a unique prompt, wait for it to finish, and check the DB string.
    const uniquePrompt = "SUPER_SECRET_E2E_PROMPT_" + Date.now();
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: uniquePrompt }],
      }),
    });
    expect(res.status).toBe(200);

    // Give relay a moment to write to DB
    await new Promise(r => setTimeout(r, 100));

    // Verify DB file does NOT contain the unique prompt
    const dbContent = readFileSync(join(tempDir, 'e2e-relay.db'));
    expect(dbContent.toString().includes(uniquePrompt)).toBe(false);
  });

  it('provider offline: Consumer gets 503', async () => {
    // Create a fresh gateway pointing to relay with no providers
    const freshRelayWallet = makeWallet();
    const freshRelay = await startRelay({
      port: 0,
      wallet: freshRelayWallet,
      dbPath: join(tempDir, 'e2e-fresh-relay.db'),
    });
    const freshRelayPort = (freshRelay as any).port;

    const consumerWallet = makeWallet();
    const freshGateway = await startGateway({
      port: 0,
      wallet: consumerWallet,
      relayUrl: `ws://127.0.0.1:${freshRelayPort}`,
    });
    const freshGatewayPort = freshGateway.port;

    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`http://127.0.0.1:${freshGatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('no_providers');

    await freshGateway.close();
    await freshRelay.close();
  });
});
