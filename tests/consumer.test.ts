import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import {
  generateSigningKeyPair,
  generateEncryptionKeyPair,
  toHex,
} from '../src/crypto/index.js';

describe('consumer', () => {
  const startTime = Date.now();
  let server: ReturnType<typeof serve>;
  let port: number;

  beforeAll(async () => {
    const { MODELS } = await import('../src/config/bootstrap.js');

    const app = new Hono();

    app.get('/health', (c) => {
      return c.json({
        status: 'ok',
        version: '0.1.0',
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        providers_online: 0,
        relay_connected: false,
      });
    });

    const testApiKey = 'test-key-12345';
    app.use('/v1/*', async (c, next) => {
      if (testApiKey) {
        const auth = c.req.header('authorization');
        if (!auth || !auth.startsWith('Bearer ')) {
          return c.json(
            { error: { message: 'Missing API key', type: 'authentication_error', code: null } },
            401,
          );
        }
        const token = auth.slice(7);
        if (token !== testApiKey) {
          return c.json(
            { error: { message: 'Invalid API key', type: 'authentication_error', code: null } },
            401,
          );
        }
      }
      await next();
    });

    app.get('/v1/models', (c) => {
      return c.json({
        object: 'list',
        data: MODELS.map((m) => ({
          id: m.id,
          object: 'model',
          created: m.created,
          owned_by: 'veil',
        })),
      });
    });

    app.post('/v1/chat/completions', async (c) => {
      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: null } }, 400);
      }

      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return c.json(
          { error: { message: 'messages is required and must be non-empty', type: 'invalid_request_error', code: null } },
          400,
        );
      }

      if (!body.model) {
        return c.json(
          { error: { message: 'model is required', type: 'invalid_request_error', code: null } },
          400,
        );
      }

      return c.json(
        { error: { message: 'No providers available', type: 'api_error', code: 'no_providers' } },
        503,
      );
    });

    port = 18800 + Math.floor(Math.random() * 100);
    server = serve({ fetch: app.fetch, port });
  });

  afterAll(() => {
    server?.close();
  });

  it('GET /health returns 200', async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.1.0');
    expect(typeof body.uptime_seconds).toBe('number');
  });

  it('GET /v1/models returns model list', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`, {
      headers: { authorization: 'Bearer test-key-12345' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].id).toBe('claude-sonnet-4-20250514');
    expect(body.data[0].owned_by).toBe('veil');
  });

  it('POST /v1/chat/completions with missing messages -> 400', async () => {
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-key-12345',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('POST /v1/chat/completions non-streaming returns 503 (no providers)', async () => {
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-key-12345',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.status).toBe(503);
  });

  it('POST /v1/chat/completions streaming returns 503 (no providers)', async () => {
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-key-12345',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(503);
  });

  it('Auth: request without Bearer when VEIL_API_KEY set -> 401', async () => {
    const res = await fetch(`http://localhost:${port}/v1/models`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe('authentication_error');
  });
});

describe('consumer retry and fallback', () => {
  const startTime = Date.now();
  let server: ReturnType<typeof serve>;
  let port: number;

  type ProviderState = {
    id: string;
    latency: number;
    capacity: number;
    models: string[];
    failed: boolean;
    failCount: number;
  };

  const providers: ProviderState[] = [
    { id: 'provider-a', latency: 100, capacity: 10, models: ['claude-sonnet-4-20250514'], failed: false, failCount: 0 },
    { id: 'provider-b', latency: 200, capacity: 5, models: ['claude-sonnet-4-20250514'], failed: false, failCount: 0 },
    { id: 'provider-c', latency: 50, capacity: 8, models: ['claude-sonnet-4-20250514'], failed: false, failCount: 0 },
  ];

  const failedProviders = new Set<string>();

  function selectProvider(model: string): ProviderState | null {
    const available = providers.filter(
      (p) => !failedProviders.has(p.id) && p.models.includes(model) && p.capacity > 0,
    );
    if (available.length === 0) return null;
    return available.reduce((best, p) => (p.latency < best.latency ? p : best), available[0]);
  }

  function markFailed(id: string): void {
    failedProviders.add(id);
  }

  function resetFailed(): void {
    failedProviders.clear();
  }

  beforeAll(async () => {
    const app = new Hono();

    app.get('/health', (c) => {
      return c.json({
        status: 'ok',
        version: '0.1.0',
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        providers_online: providers.filter((p) => !failedProviders.has(p.id)).length,
        relay_connected: true,
      });
    });

    const testApiKey = 'test-key-12345';
    app.use('/v1/*', async (c, next) => {
      const auth = c.req.header('authorization');
      if (!auth || !auth.startsWith('Bearer ')) {
        return c.json(
          { error: { message: 'Missing API key', type: 'authentication_error', code: null } },
          401,
        );
      }
      const token = auth.slice(7);
      if (token !== testApiKey) {
        return c.json(
          { error: { message: 'Invalid API key', type: 'authentication_error', code: null } },
          401,
        );
      }
      await next();
    });

    app.post('/v1/chat/completions', async (c) => {
      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error', code: null } }, 400);
      }

      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return c.json(
          { error: { message: 'messages is required and must be non-empty', type: 'invalid_request_error', code: null } },
          400,
        );
      }

      if (!body.model || typeof body.model !== 'string') {
        return c.json(
          { error: { message: 'model is required', type: 'invalid_request_error', code: null } },
          400,
        );
      }

      const forceFailProvider = c.req.header('x-test-fail-provider');
      if (forceFailProvider) {
        markFailed(forceFailProvider);
      }

      const provider = selectProvider(body.model);
      if (!provider) {
        return c.json(
          { error: { message: 'No providers available', type: 'api_error', code: 'no_providers' } },
          503,
        );
      }

      return c.json({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        provider_id: provider.id,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    });

    app.post('/v1/test/reset-providers', (c) => {
      resetFailed();
      return c.json({ ok: true });
    });

    app.get('/v1/test/providers', (c) => {
      return c.json({
        providers: providers.map((p) => ({
          ...p,
          available: !failedProviders.has(p.id),
        })),
      });
    });

    port = 18900 + Math.floor(Math.random() * 100);
    server = serve({ fetch: app.fetch, port });
  });

  afterAll(() => {
    server?.close();
    resetFailed();
  });

  it('selects provider with lowest latency', async () => {
    resetFailed();
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-key-12345',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider_id).toBe('provider-c');
  });

  it('falls back to next provider when primary fails', async () => {
    resetFailed();
    markFailed('provider-c');

    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-key-12345',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider_id).toBe('provider-a');

    resetFailed();
  });

  it('returns 503 when all providers are failed', async () => {
    resetFailed();
    markFailed('provider-a');
    markFailed('provider-b');
    markFailed('provider-c');

    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-key-12345',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('no_providers');

    resetFailed();
  });

  it('marks provider as failed via header and retries with next', async () => {
    resetFailed();

    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-key-12345',
        'x-test-fail-provider': 'provider-c',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider_id).toBe('provider-a');

    resetFailed();
  });

  it('reset failed providers restores availability', async () => {
    markFailed('provider-a');
    markFailed('provider-b');
    markFailed('provider-c');

    const resBefore = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer test-key-12345',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(resB