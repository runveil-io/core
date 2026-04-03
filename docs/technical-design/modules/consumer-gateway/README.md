# Consumer Gateway

## Purpose

This module exposes Veil as a local OpenAI-compatible gateway for end users, tools, and agents.

## Responsibility Boundary

- expose an OpenAI-compatible HTTP API
- authenticate local callers
- select a Provider from Relay-published capacity
- sign and seal outbound requests
- convert Relay responses into client-facing JSON or SSE
- enforce per-request budget and timeout

## Out Of Scope

- does not execute upstream inference directly
- does not persist witness or contribution ledger data
- does not define transport protocol semantics on its own

## Interface

```ts
type RelayMode = 'bootstrap' | 'static' | 'manual';
type QuoteUnit = 'usd_estimate';

interface GatewayOptions {
  port: number;
  wallet: Wallet;
  relayMode?: RelayMode;
  relayUrl?: string;
  bootstrapUrl?: string;
  apiKey?: string;
  defaultQuoteBudget?: number;
  quoteUnit?: QuoteUnit;
}

function startGateway(
  options: GatewayOptions,
): Promise<{ close(): Promise<void>; port: number }>;
```

## Data Flow

Input: HTTP `chat/completions` request.  
Process: auth, model validation, Relay discovery or selection, Provider selection, request signing, payload sealing, Relay round-trip, response decode.  
Output: OpenAI-compatible response.

## State

- memory: Relay connection, Provider list, pending requests, budget trackers
- persistence: none beyond local wallet and config files owned elsewhere

## Errors

- invalid request body
- unknown model
- Relay unavailable
- Provider unavailable
- streaming interruption
- no usable Relay discovered for the selected mode

## Security Constraints

- local API auth must be supported
- request signatures must bind request metadata and ciphertext hash
- budget checks must fail closed
- quote budgeting must stay separate from final settlement semantics

## Test Requirements

- OpenAI-compatible request and response
- streaming
- budget overrun and timeout
- no-Provider path

## Dependencies

- calls: `network`, `crypto`, `wallet`, `budget`
- called by: local AI clients, IDEs, agents

---

## Implementation Details

**Source:** `src/consumer/index.ts`, `src/consumer/budget.ts`, `src/consumer/anthropic-stream.ts`

### Key Data Structures

```ts
// src/consumer/index.ts
export interface GatewayOptions {
  port: number;
  wallet: Wallet;
  relayUrl: string;
  apiKey?: string;
  discoveryClient?: RelayDiscoveryClient;
  defaultBudgetUsdc?: number;
}

// Pending request tracking (in-memory Map)
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  onChunk?: (msg: WsMessage) => void;
}>();

// src/consumer/budget.ts
export interface BudgetConfig {
  max_cost_usdc: number;       // default $1.00
  max_duration_ms?: number;    // default 120_000 (2 min)
}

export interface BudgetTracker {
  addUsage(inputTokens: number, outputTokens: number): void;
  check(): BudgetCheckResult | null;
  checkTimeout(): boolean;
  summary(): BudgetSummary;
  remaining(): number;
}
```

### Core Flow

1. **Relay connection**: `connectRelay()` resolves URL via `RelayDiscoveryClient` (if configured) or uses static URL. Maintains excluded relay list for failover.
2. **Provider selection**: `selectProvider(model, excludeIds)` filters by model + capacity > 0. Falls back to random selection if exclusion list exhausts all.
3. **Request building**: `buildRequest()` seals inner plaintext with `nacl.box` using provider's encryption pubkey, signs outer envelope with `Ed25519`.
4. **Retry logic**: Up to 3 retries with exponential backoff (1s, 2s, 4s). Non-retryable errors: `invalid_request`, `rate_limit`, `invalid_signature`, `decrypt_failed`, mid-stream errors.
5. **Budget guard**: `createBudgetTracker()` uses `calculateCostByModel()` from metering module. Streaming chunks estimate ~1 output token per 4 chars. Cost check on every chunk.

### State Management

- **In-memory**: `providers[]` (from relay `provider_list`), `relayConnected` flag, `pendingRequests` Map, `excludedRelays[]`
- **No persistence**: gateway is stateless across restarts

### Error Handling

- Auth: constant-time comparison via `constantTimeCompare()` to prevent timing attacks
- Missing relay: returns 502 `Relay not connected`
- No providers: returns 503 `no_providers` (after retry exhaustion)
- Budget exceeded: returns 402 with `budget_exceeded` error and usage details
- Timeout: configurable via `VEIL_REQUEST_TIMEOUT` env (default 120s)

## API Specification

### HTTP Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Uptime, provider count, relay status |
| GET | `/v1/models` | Bearer | List available models |
| POST | `/v1/chat/completions` | Bearer | OpenAI-compatible chat completion |

### `startGateway(options: GatewayOptions): Promise<{ close(): Promise<void>; port: number }>`

Starts HTTP server (Hono + @hono/node-server) and connects to relay.

### Request Body Extensions

```ts
// Non-standard budget field (optional)
{
  ...standardOpenAIChatRequest,
  budget?: {
    max_cost_usdc?: number;    // override per-request
    max_duration_ms?: number;
  }
}
```

### Response Headers

- `x-veil-budget-remaining`: remaining budget in USDC (6 decimal places)

## Integration Protocol

- **→ Relay (WebSocket)**: sends `list_providers`, `request` messages; receives `provider_list`, `response`, `stream_start`, `stream_chunk`, `stream_end`, `error`
- **→ Discovery Client**: `selectRelay(excludedRelays)` for relay failover
- **→ Crypto**: `seal()`, `open()`, `sign()`, `sha256()` for E2E encryption
- **→ Metering**: `calculateCostByModel()` for budget estimation
- **Config**: reads `MODELS`, `MODEL_MAP` from `src/config/bootstrap.ts`

## Current Implementation Status

- ✅ OpenAI-compatible `/v1/chat/completions` (streaming + non-streaming) [IMPLEMENTED]
- ✅ `/v1/models` endpoint [IMPLEMENTED]
- ✅ `/health` endpoint [IMPLEMENTED]
- ✅ Bearer token auth with constant-time comparison [IMPLEMENTED]
- ✅ E2E encryption (nacl.box seal/open) [IMPLEMENTED]
- ✅ Per-request budget guard (cost + timeout) [IMPLEMENTED]
- ✅ Retry with exponential backoff (up to 3 retries) [IMPLEMENTED]
- ✅ Relay discovery failover via `RelayDiscoveryClient` [IMPLEMENTED]
- ⚠️ Streaming budget tracking uses heuristic (~1 token per 4 chars) [PARTIAL]
- ❌ Multi-relay simultaneous connections [DESIGN ONLY]
- ❌ Request-level Provider preference or pinning [DESIGN ONLY]

---

## Design Specifications for Unimplemented Items

### Multi-Relay Simultaneous Connections [DESIGN SPEC · Phase 2]

```ts
interface MultiRelayConfig {
  relayUrls: string[];             // 2+ relay endpoints
  strategy: 'failover' | 'round-robin' | 'latency-preferred';
  maxConcurrentRelays: number;     // default 2
  failoverTimeoutMs: number;       // switch to next relay after this (default 5000)
}

// Behavior:
// - Gateway maintains WebSocket connections to multiple relays simultaneously
// - 'failover': use primary, switch on disconnect/timeout
// - 'round-robin': distribute requests across relays
// - 'latency-preferred': route to lowest recent RTT relay
// - Relay health tracked per-connection (last success, error count, avg latency)
// - On all relays down: queue requests up to 10s, then 503
// - Relay list refreshed from bootstrap on configurable interval (default 5min)
```

### Request-Level Provider Preference [DESIGN SPEC · Phase 4]

```ts
interface ProviderPreference {
  preferredProviders?: string[];   // provider pubkeys, ordered by preference
  excludeProviders?: string[];     // provider pubkeys to avoid
  maxLatencyMs?: number;           // reject providers with higher avg latency
  modelPin?: string;               // force specific model variant
}

// Passed via x-veil-provider-preference header (JSON, base64-encoded)
// Relay honors preference on best-effort basis (not guaranteed)
// If preferred provider unavailable, falls back to normal routing
// Provider preference never leaks to other consumers or providers
```
