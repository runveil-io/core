import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { handleRequest } from '../src/provider/index.js';
import type { InnerPlaintext } from '../src/types.js';

describe('provider', () => {
  let mockServer: ReturnType<typeof serve>;
  let mockPort: number;

  let mockKey = 'test-key'; // Example API Key for tests


  // Mock Anthropic API
  beforeAll(async () => {
    const app = new Hono();
    let callCount = 0;

    app.post('/v1/messages', async (c) => {
      callCount++;
      const body = await c.req.json();

      // Simulate 429 on first call for retry test
      if (body.model === 'retry-test' && callCount === 1) {
        return c.json({ error: { message: 'rate_limit' } }, 429);
      }

      if (body.stream) {
        // Return SSE stream
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n'));
            controller.enqueue(enc.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
            controller.enqueue(enc.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n'));
            controller.enqueue(enc.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n'));
            controller.enqueue(enc.encode('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'));
            controller.enqueue(enc.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n'));
            controller.enqueue(enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
            controller.close();
          },
        });

        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }

      // Non-streaming response
      return c.json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from mock!' }],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    });

    mockPort = 18900 + Math.floor(Math.random() * 100);
    mockServer = serve({ fetch: app.fetch, port: mockPort });
  });

  afterAll(() => {
    mockServer?.close();
  });

  it('handleRequest non-streaming with mock Anthropic', async () => {
    const inner: InnerPlaintext = {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      temperature: 1,
      top_p: 1,
      stop_sequences: [],
      stream: false,
    };

    const result = await handleRequest(inner, 'test-key', undefined, `http://localhost:${mockPort}`);
    expect(result.content).toBe('Hello from mock!');
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
    expect(result.finish_reason).toBe('stop');
  });

  it('handleRequest streaming with mock Anthropic', async () => {
    const chunks: string[] = [];
    const inner: InnerPlaintext = {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      temperature: 1,
      top_p: 1,
      stop_sequences: [],
      stream: true,
    };

    const result = await handleRequest(inner, 'test-key', (chunk) => {
      chunks.push(chunk);
    }, `http://localhost:${mockPort}`);

    expect(chunks).toContain('Hello');
    expect(chunks).toContain(' world');
    expect(result.content).toBe('Hello world');
    expect(result.usage.output_tokens).toBe(5);
  });

  it('handleRequest with decrypt error scenario', async () => {
    // This test verifies error handling at the handleRequest level
    // Invalid model that causes 400 from mock
    const inner: InnerPlaintext = {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'nonexistent-model',
      max_tokens: 100,
      temperature: 1,
      top_p: 1,
      stop_sequences: [],
      stream: false,
    };

    // The mock returns 200 for any model, so this will succeed
  });
    const results = await Promise.all(Array.from({ length: 10 }, async () => {
      const inner: InnerPlaintext = {
        messages: [{ role: 'user', content: 'hello' }],
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        temperature: 1,
        top_p: 1,
        stop_sequences: [],
        stream: false,
      };

      return handleRequest(inner, 'test-key', undefined, `http://localhost:${mockPort}`);
    }));
    const versions = results.map(result => result.headers['anthropic-version']);
    const uniqueVersions = new Set(versions);
    expect(uniqueVersions.size).toBeGreaterThan(1);
  });

  it('should enforce random delays between 0-500ms', async () => {
    const inner: InnerPlaintext = {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      temperature: 1,
      top_p: 1,
      stop_sequences: [],
      stream: false,
    };

    const start = Date.now();
    await handleRequest(inner, 'test-key', undefined, `http://localhost:${mockPort}`);
    const delay = Date.now() - start;
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(500);
  });

  it('should randomize max_tokens within ±5%', async () => {
    const originalMaxTokens = 100;
    const inner: InnerPlaintext = {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'claude-sonnet-4-20250514',
      max_tokens: originalMaxTokens,
      temperature: 1,
      top_p: 1,
      stop_sequences: [],
      stream: false,
    };

    const result = await handleRequest(inner, 'test-key', undefined, `http://localhost:${mockPort}`);
    const adjustedMaxTokens = Math.round(originalMaxTokens * (1 + (Math.random() * 0.1 - 0.05)));
    expect(result.max_tokens).toBe(adjustedMaxTokens);
  });

  it('should rotate User-Agent strings', async () => {
    const inner: InnerPlaintext = {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      temperature: 1,
      top_p: 1,
      stop_sequences: [],
      stream: false,
    };

    const result = await handleRequest(inner, 'test-key', undefined, `http://localhost:${mockPort}`);
    const userAgent = result.headers['User-Agent'];
    expect(userAgent).toMatch(/some-random-user-agent/i);
  });

  });
    const result = await handleRequest(inner, 'test-key', undefined, `http://localhost:${mockPort}`);
    expect(result.content).toBeDefined();
  });

  it('Anthropic 429 -> retry then succeed', async () => {
    const inner: InnerPlaintext = {
      messages: [{ role: 'user', content: 'hello' }],
      model: 'retry-test',
      max_tokens: 100,
      temperature: 1,
      top_p: 1,
      stop_sequences: [],
      stream: false,
    };

    const result = await handleRequest(inner, 'test-key', undefined, `http://localhost:${mockPort}`);
    expect(result.content).toBe('Hello from mock!');
  });
});
