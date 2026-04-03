# Bootstrap & Discovery

## Purpose

This module defines how Relay nodes are registered, refreshed, listed, and selected.
It keeps Relay as an explicit market role by making broker availability and selection a visible operational dependency.

## Responsibility Boundary

- register Relay nodes
- accept Relay heartbeats
- publish Relay lists
- score and select Relays on the client side

## Out Of Scope

- does not forward inference traffic
- does not decrypt business payloads
- does not store Consumer prompt content

## Interface

```ts
function createBootstrapApp(db: Database): Hono;

class RelayDiscoveryClient {
  fetchRelays(region?: string): Promise<RelayInfo[]>;
  selectRelay(exclude?: string[]): Promise<RelayScore | null>;
  refreshCache(): Promise<RelayInfo[]>;
}
```

## Data Flow

Input: Relay register and heartbeat requests, Consumer and Provider list fetches.  
Process: verify signatures, update registry state, cache Relay lists, compute scores.  
Output: active Relay inventory and best-Relay selections.

## State

- persistent: `relay_registry`
- memory: cached Relay list, latency measurements

## Errors

- invalid signature
- duplicate endpoint
- stale Relay state
- bootstrap fetch failure

## Security Constraints

- Bootstrap handles Relay metadata only
- Relay registration must be signed
- selection inputs must be bounded and cacheable

## Test Requirements

- register, heartbeat, offline prune
- cached list behavior
- score calculation and selection

## Dependencies

- calls: `crypto`, `logger`
- called by: `consumer`, `provider`, Relay operators

---

## Implementation Details

**Source:** `src/bootstrap/server.ts`, `src/discovery/client.ts`, `src/discovery/types.ts`

### Key Data Structures

```ts
// src/discovery/types.ts
interface RelayInfo {
  relay_pubkey: string;
  relay_id: string;
  endpoint: string;
  models_supported: string[];
  fee_pct: number;
  region: string;
  capacity: number;
  active_providers: number;
  reputation_score: number;
  uptime_pct: number;
  witness_count: number;
  health_latency_ms: number | null;
  version: string;
}

interface RelayScore {
  relay: RelayInfo;
  score: number;
  breakdown: { latency; fee; uptime; reputation; exploration };
}

interface DiscoveryConfig {
  bootstrapUrl: string;
  cacheTtlMs?: number;    // default 60_000
  maxRelays?: number;     // default 10
}

// src/bootstrap/server.ts — DB schema
// relay_registry table: relay_pubkey (PK), relay_id, endpoint (UNIQUE),
// models_supported, fee_pct, region, capacity, version, active_providers,
// active_requests, uptime_seconds, registered_at, last_heartbeat,
// status ('online'|'stale'|'offline'|'banned'), witness_count,
// reputation_score, total_uptime_pct, ban_reason, ban_until
```

### Bootstrap Server (`src/bootstrap/server.ts`)

- **Hono HTTP app** with 5 endpoints
- **Signature verification**: Ed25519 on deterministic JSON payloads (`buildRegisterSignable`, `buildHeartbeatSignable`)
- **Timestamp tolerance**: ±5 min for registration
- **Health check**: `runHealthCheck()` marks relays offline if no heartbeat for >90s
- **Pruning**: `pruneOfflineRelays()` deletes offline relays after 24h
- **Duplicate endpoint protection**: UNIQUE constraint on `endpoint` column

### Discovery Client (`src/discovery/client.ts`)

- **Cache**: in-memory `{ relays, fetchedAt }` with configurable TTL (default 60s)
- **Scoring**: weighted multi-factor score (0-100 per dimension):
  - latency (35%): 100 for ≤50ms, 0 for ≥500ms, linear interpolation
  - fee (25%): 100 for 0%, 0 for ≥10%
  - uptime (20%): direct percentage
  - reputation (10%): `log10(witness_count + 1) × 33.3`, capped at 100
  - exploration (10%): bonus for new relays with <100 witnesses
- **Latency measurement**: WebSocket connect time via `pingRelay()`, falls back to 200ms if ws unavailable
- **Region filtering**: prefix match on `region` field

### Error Handling

- Invalid signature → 401 `invalid_signature`
- Missing fields → 400 `missing_fields`
- Timestamp expired → 400 `timestamp_expired`
- Duplicate endpoint → 409 `duplicate_endpoint`
- Relay not found (heartbeat/delete) → 404
- Bootstrap fetch failure → thrown Error with status code

## API Specification

### Bootstrap Server Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/relays/register` | Ed25519 sig | Register/update relay |
| POST | `/v1/relays/heartbeat` | Ed25519 sig | Update relay state |
| GET | `/v1/relays` | None | List online relays (scored) |
| DELETE | `/v1/relays/:pubkey` | None | Deregister relay |
| GET | `/health` | None | Bootstrap health + relay count |

### `createBootstrapApp(db: Database): Hono`

### Discovery Client

```ts
class RelayDiscoveryClient {
  constructor(config: DiscoveryConfig)
  fetchRelays(region?: string): Promise<RelayInfo[]>
  selectRelay(exclude?: string[]): Promise<RelayScore | null>
  refreshCache(): Promise<RelayInfo[]>
}
```

### Exported Utilities

```ts
initDatabase(dbPath?: string): Database.Database
runHealthCheck(db: Database, now?: number): void
pruneOfflineRelays(db: Database, now?: number): void
computeRelayScore(relay: RelayInfo, measuredLatencyMs: number | null): RelayScore
```

## Integration Protocol

- **Called by Consumer**: `RelayDiscoveryClient.selectRelay()` for relay failover in gateway
- **Called by Provider**: `RelayDiscoveryClient.fetchRelays()` for multi-relay connectivity
- **Called by Relay**: HTTP POST to bootstrap for registration + heartbeat (every 30s)
- **Response format**: `{ relays: RelayInfo[], cache_ttl_seconds: 60, bootstrap_version: '0.1.0' }`
- **Config**: `DEFAULT_BOOTSTRAP_URL = 'https://bootstrap.runveil.io'`, `RELAY_DISCOVERY_CACHE_TTL_MS = 60_000`, `RELAY_DISCOVERY_MAX_RELAYS = 20`

## Current Implementation Status

- ✅ Bootstrap server with register, heartbeat, list, delete, health [IMPLEMENTED]
- ✅ Ed25519 signature verification for relay registration [IMPLEMENTED]
- ✅ Discovery client with caching and TTL [IMPLEMENTED]
- ✅ Multi-factor relay scoring (latency, fee, uptime, reputation, exploration) [IMPLEMENTED]
- ✅ WebSocket latency measurement [IMPLEMENTED]
- ✅ Health check (90s stale threshold) and pruning (24h) [IMPLEMENTED]
- ✅ Region and model filtering [IMPLEMENTED]
- ⚠️ Reputation score is static in DB, not dynamically computed from witness data [PARTIAL]
- ❌ Relay banning/unbanning workflow [DESIGN ONLY]
- ❌ Health check probes from bootstrap to relays [DESIGN ONLY]

---

## Design Specifications for Unimplemented Items

### Relay Banning/Unbanning Workflow [DESIGN SPEC · Phase 3]

```ts
interface RelayBanRecord {
  relayPubkey: string;
  reason: 'unresponsive' | 'witness_mismatch' | 'protocol_violation' | 'operator_manual';
  bannedAt: number;
  expiresAt?: number;              // null = permanent until manual unban
  bannedBy: 'auto' | 'operator';
}

// Auto-ban triggers:
// 1. Relay fails 5 consecutive health probes → ban 1h
// 2. Relay returns invalid witness signatures → ban 24h
// 3. Relay violates protocol (e.g. version mismatch) → ban until fixed
//
// Unban:
// - Time-based bans auto-expire
// - Operator: veil bootstrap unban <relay-pubkey>
// - On unban, relay re-enters discovery pool but at lowest priority
//
// Storage: ban records in bootstrap.db alongside relay registry
// Consumer/provider discovery: banned relays filtered from results
```

### Health Check Probes [DESIGN SPEC · Phase 3]

```ts
interface HealthProbeConfig {
  intervalMs: number;              // default 60_000 (1 min)
  timeoutMs: number;               // default 5_000
  consecutiveFailsForBan: number;  // default 5
  probeEndpoint: string;           // GET /v1/health on relay
}

interface RelayHealthStatus {
  relayPubkey: string;
  lastProbeAt: number;
  lastSuccessAt: number;
  consecutiveFails: number;
  avgLatencyMs: number;            // rolling 10-probe average
  status: 'healthy' | 'degraded' | 'unreachable';
}

// Probe flow:
// 1. Bootstrap sends GET /v1/health to each registered relay every intervalMs
// 2. Relay responds with { status: 'ok', uptime, connectedProviders }
// 3. Bootstrap updates RelayHealthStatus
// 4. 'degraded': latency > 2x average → lower priority in discovery results
// 5. 'unreachable': consecutiveFails >= threshold → trigger auto-ban
// 6. Health data exposed: GET /v1/relays includes health scores
```
