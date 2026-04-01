/**
 * API Proxy — Privilege Separation for API Keys
 * 
 * This process is INDEPENDENT from veil-core.
 * API key lives ONLY in this process's memory.
 * Veil Provider talks to localhost:PROXY_PORT with PROXY_SECRET.
 * 
 * Security model:
 * - Binds 127.0.0.1 only (no external access)
 * - Requires PROXY_SECRET header on every request
 * - API key never leaves this process
 * - Even if veil-core has bugs, key cannot leak
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { Logger } from '../logger.js';

const logger = new Logger('api_proxy');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  logger.error('ANTHROPIC_API_KEY environment variable required');
  process.exit(1);
}

const PROXY_SECRET = process.env.PROXY_SECRET || randomBytes(32).toString('hex');
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '4000', 10);
const UPSTREAM = process.env.UPSTREAM_URL || 'https://api.anthropic.com';

const app = new Hono();

// Auth middleware — reject requests without correct secret
app.use('*', async (c, next) => {
  const secret = c.req.header('x-proxy-secret');
  if (secret !== PROXY_SECRET) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

// Forward all requests to upstream API
app.all('/v1/*', async (c) => {
  const upstreamUrl = `${UPSTREAM}${c.req.path}`;
  
  const headers: Record<string, string> = {
    'x-api-key': API_KEY,
    'anthropic-version': '2023-06-01',
  };

  // Forward content-type if present
  const ct = c.req.header('content-type');
  if (ct) headers['content-type'] = ct;

  const method = c.req.method;
  const body = method === 'POST' || method === 'PUT' 
    ? await c.req.text() 
    : undefined;

  try {
    const res = await fetch(upstreamUrl, { method, headers, body });

    // Stream response back (important for SSE streaming)
    const responseHeaders = new Headers();
    responseHeaders.set('content-type', res.headers.get('content-type') || 'application/json');
    
    if (res.body) {
      return new Response(res.body, {
        status: res.status,
        headers: responseHeaders,
      });
    }

    return c.json(await res.json(), res.status as any);
  } catch (err: any) {
    logger.error('upstream_error', { error: err.message });
    return c.json({ error: { message: 'Upstream API unreachable', type: 'api_error' } }, 502);
  }
});

// Health check (no auth needed)
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    upstream: UPSTREAM,
    port: PROXY_PORT,
  });
});

serve({ fetch: app.fetch, port: PROXY_PORT, hostname: '127.0.0.1' }, () => {
  logger.info('proxy_started', { port: PROXY_PORT });
  // Output secret so parent process can capture it
  // Only printed once at startup, not logged elsewhere
  console.log(`PROXY_SECRET=${PROXY_SECRET}`);
});
