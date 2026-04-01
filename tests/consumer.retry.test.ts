import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { startGateway } from '../src/consumer/index.js';
import { generateEncryptionKeyPair, generateSigningKeyPair, toHex, sign, seal } from '../src/crypto/index.js';

describe('consumer retries', () => {
  let wss: WebSocketServer | null = null;
  let relayPort = 30010;
  let gw: any = null;
  let relaySockets: any[] = [];
  const consumerWallet = {
    signingPublicKey: new Uint8Array(32),
    signingSecretKey: new Uint8Array(64),
    encryptionPublicKey: new Uint8Array(32),
    encryptionSecretKey: new Uint8Array(64)
  };

  beforeAll(async () => {
    const k1 = generateSigningKeyPair();
    const k2 = generateEncryptionKeyPair();
    consumerWallet.signingPublicKey = k1.publicKey;
    consumerWallet.signingSecretKey = k1.secretKey;
    consumerWallet.encryptionPublicKey = k2.publicKey;
    consumerWallet.encryptionSecretKey = k2.secretKey;
  });

  afterEach(async () => {
    if (gw) { await gw.close(); gw = null; }
    if (wss) { wss.close(); wss = null; }
    relaySockets.forEach(s => s.terminate());
    relaySockets = [];
    relayPort += 3; // ensure no port conflicts
  });

  it('retries on 5xx and fails after 3 retries', async () => {
    wss = new WebSocketServer({ port: relayPort });
    let reqCount = 0;
    
    wss.on('connection', (ws) => {
      relaySockets.push(ws);
      ws.on('message', (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'list_providers') {
          ws.send(JSON.stringify({
            type: 'provider_list',
            payload: {
              providers: [
                { provider_id: 'p1', models: ['claude-sonnet-4-20250514'], capacity: 10, encryption_pubkey: toHex(new Uint8Array(32)) }
              ]
            }
          }));
        } else if (msg.type === 'request') {
          reqCount++;
          // Always send 500
          ws.send(JSON.stringify({
            type: 'error',
            request_id: msg.request_id,
            payload: { code: 'provider_error', message: 'failed' }
          }));
        }
      });
    });

    gw = await startGateway({ port: relayPort + 1, wallet: consumerWallet, relayUrl: `ws://localhost:${relayPort}` });
    
    // Wait for provider list
    await new Promise(r => setTimeout(r, 100));

    const start = Date.now();
    const res = await fetch(`http://localhost:${relayPort + 1}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', messages: [{role: 'user', content: 'hi'}] })
    });

    // Expect 4 requests total (1 initial + 3 retries)
    expect(reqCount).toBe(4);
    expect(res.status).toBe(500);
    const elapsed = Date.now() - start;
    // 1s + 2s + 4s = 7s wait total.
    expect(elapsed).toBeGreaterThanOrEqual(7000);
  }, 10000);

  it('fails instantly on 4xx errors', async () => {
    wss = new WebSocketServer({ port: relayPort });
    let reqCount = 0;
    
    wss.on('connection', (ws) => {
      relaySockets.push(ws);
      ws.on('message', (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'list_providers') {
          ws.send(JSON.stringify({
            type: 'provider_list',
            payload: {
              providers: [
                { provider_id: 'p1', models: ['claude-sonnet-4-20250514'], capacity: 10, encryption_pubkey: toHex(new Uint8Array(32)) }
              ]
            }
          }));
        } else if (msg.type === 'request') {
          reqCount++;
          // Send 400 invalid_request error
          ws.send(JSON.stringify({
            type: 'error',
            request_id: msg.request_id,
            payload: { code: 'invalid_request', message: 'failed' }
          }));
        }
      });
    });

    gw = await startGateway({ port: relayPort + 1, wallet: consumerWallet, relayUrl: `ws://localhost:${relayPort}` });
    
    await new Promise(r => setTimeout(r, 100));

    const start = Date.now();
    const res = await fetch(`http://localhost:${relayPort + 1}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', messages: [{role: 'user', content: 'hi'}] })
    });

    // Expect exactly 1 request (no retries)
    expect(reqCount).toBe(1);
    expect(res.status).toBe(500); // Because it is converted to "Internal error: invalid_request" or similar
    const elapsed = Date.now() - start;
    // Should fail instantly, < 500ms
    expect(elapsed).toBeLessThan(1000); // Safe margin
  });

  it('fails instantly on stream chunk error (mid-stream)', async () => {
    wss = new WebSocketServer({ port: relayPort });
    let reqCount = 0;
    
    wss.on('connection', (ws) => {
      relaySockets.push(ws);
      ws.on('message', (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'list_providers') {
          ws.send(JSON.stringify({
            type: 'provider_list',
            payload: {
              providers: [
                { provider_id: 'p1', models: ['claude-sonnet-4-20250514'], capacity: 10, encryption_pubkey: toHex(new Uint8Array(32)) }
              ]
            }
          }));
        } else if (msg.type === 'request') {
          reqCount++;
          // Send 1 stream_chunk, then error
          ws.send(JSON.stringify({
            type: 'stream_chunk',
            request_id: msg.request_id,
            payload: { encrypted_chunk: Buffer.from(seal(new TextEncoder().encode('{"content":"hello"}'), consumerWallet.encryptionPublicKey, consumerWallet.encryptionSecretKey)).toString('base64') }
          }));

          setTimeout(() => {
             ws.send(JSON.stringify({
               type: 'error',
               request_id: msg.request_id,
               payload: { code: 'provider_error', message: 'crash' }
             }));
          }, 50);
        }
      });
    });

    gw = await startGateway({ port: relayPort + 1, wallet: consumerWallet, relayUrl: `ws://localhost:${relayPort}` });
    
    await new Promise(r => setTimeout(r, 100));

    const res = await fetch(`http://localhost:${relayPort + 1}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', stream: true, messages: [{role: 'user', content: 'hi'}] })
    });

    expect(res.status).toBe(200);

    const reader = res.body?.getReader();
    let done = false;
    let chunks = 0;
    while (!done) {
      const result = await reader?.read();
      if (!result) break;
      if (result.done) done = true;
      else chunks++;
    }

    // Attempted exactly 1 request because it fails mid-stream
    expect(reqCount).toBe(1);
    expect(chunks).toBeGreaterThan(0);
  });
});
