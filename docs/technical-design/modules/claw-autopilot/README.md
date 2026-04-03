# Claw Autopilot

## Purpose

This module defines the target automation boundary that turns operator intent into low-touch node operation.

## Responsibility Boundary

- capture join-network and sell-capacity intent
- validate local prerequisites before a node is exposed to the network
- orchestrate wallet, discovery, provider, and relay startup flows
- reconcile pricing policy, health status, pause and resume behavior
- persist operator intent and automation state

## Out Of Scope

- does not proxy inference traffic directly
- does not decrypt request payloads
- does not replace Relay admission logic
- does not invent settlement outcomes without witness input

## Interface

```ts
interface OperatorIntent {
  mode: 'join-network' | 'sell-capacity' | 'pause-market';
  providerMode: 'api-capacity' | 'self-hosted';
  relayMode: 'bootstrap' | 'static' | 'manual';
}

interface AutopilotPolicy {
  maxDailyLossQuote: number;
  minMarginPct: number;
  autoPauseOnHealthDegrade: boolean;
}

interface AutopilotRuntime {
  close(): Promise<void>;
  reconcile(): Promise<void>;
}

function startAutopilot(
  intent: OperatorIntent,
  policy: AutopilotPolicy,
): Promise<AutopilotRuntime>;
```

## Data Flow

Input: operator intent, local credentials, discovery results, Provider health, witness and pricing signals.  
Process: validate, plan desired runtime state, start or reconfigure nodes, monitor drift, reconcile changes.  
Output: running node state, policy actions, pause or resume decisions, automation logs.

## State

- persistent: operator intent, policy snapshots, last known relay choice, last known provider offer state
- memory: reconciliation loop state, health snapshots, pending actions, cooldown timers

## Errors

- missing credentials for selected provider mode
- no reachable Relay candidates
- policy conflict that would expose capacity unsafely
- failed start or reconcile action
- repeated health degradation causing forced pause

## Security Constraints

- operator credentials must never be exposed outside local secret boundaries
- autopilot must fail closed when policy or health signals are ambiguous
- automation must not bypass Relay, Provider, or settlement security checks

## Test Requirements

- join flow with valid prerequisites
- sell-capacity flow with policy application
- pause and resume on health degradation
- recovery after relay loss
- no-start behavior when secrets or policy requirements are missing

## Dependencies

- calls: `wallet-identity`, `bootstrap-discovery`, `provider-engine`, `relay`, `pricing-risk-policy`, `settlement-payout`
- called by: `cli`

---

## Implementation Details

**Source:** No implementation exists.

## API Specification

No code. See architecture section above for planned interface.

## Integration Protocol

No code. Planned to orchestrate wallet, discovery, provider, and relay modules. CLI would expose `veil autopilot init/join/show` commands.

## Current Implementation Status

- ❌ `startAutopilot()` [DESIGN ONLY]
- ❌ OperatorIntent / AutopilotPolicy types [DESIGN ONLY]
- ❌ Join-network flow [DESIGN ONLY]
- ❌ Sell-capacity with policy enforcement [DESIGN ONLY]
- ❌ Health-based pause/resume [DESIGN ONLY]
- ❌ Reconciliation loop [DESIGN ONLY]
- ❌ CLI commands (`veil autopilot init/join/show`) [DESIGN ONLY]

This module is planned for **Phase 3** (Guided Operator Automation) and **Phase 6** (Low-Touch Market Operation). No source code exists in `src/`.

---

## Design Specifications for Unimplemented Items

### OperatorIntent / AutopilotPolicy — Extended Types [DESIGN SPEC · Phase 3]

```ts
interface OperatorIntent {
  mode: 'join-network' | 'sell-capacity' | 'pause-market';
  providerMode: 'api-capacity' | 'self-hosted';
  relayMode: 'bootstrap' | 'static' | 'manual';
  models: string[];               // models to expose (e.g. ['claude-3-sonnet'])
  relayUrls?: string[];            // for static/manual mode
  bootstrapUrl?: string;           // override default bootstrap
}

interface AutopilotPolicy {
  maxDailyLossQuote: number;
  minMarginPct: number;
  autoPauseOnHealthDegrade: boolean;
  healthThreshold: number;         // below this → pause (default 0.3)
  reconcileIntervalMs: number;     // default 30_000 (30s)
  maxReconnectAttempts: number;    // before escalating to pause (default 5)
}

interface AutopilotState {
  intent: OperatorIntent;
  policy: AutopilotPolicy;
  status: 'starting' | 'running' | 'paused' | 'error' | 'stopped';
  pauseState?: PauseState;         // from pricing-risk-policy
  lastReconcileAt: number;
  relayConnections: { url: string; connected: boolean; since: number }[];
  activeOffers: CapacityOffer[];
}
```

### startAutopilot() Main Loop [DESIGN SPEC · Phase 3/6]

```ts
async function startAutopilot(
  intent: OperatorIntent,
  policy: AutopilotPolicy,
): Promise<AutopilotRuntime> {
  // 1. Prerequisite validation (fail fast)
  const wallet = await loadWallet();        // wallet-identity
  if (!wallet) throw new AutopilotError('no_wallet');
  const creds = await validateCredentials(intent.providerMode);
  if (!creds) throw new AutopilotError('missing_credentials');

  // 2. Discovery phase
  const relays = await discoverRelays(intent);  // bootstrap-discovery
  if (relays.length === 0) throw new AutopilotError('no_relays');

  // 3. Start provider engine
  const provider = await startProvider({
    wallet, relayUrls: relays.map(r => r.url), ...creds,
  });

  // 4. Start reconciliation loop
  const timer = setInterval(() => reconcile(state, policy), policy.reconcileIntervalMs);

  // 5. Return runtime handle
  return {
    async close() { clearInterval(timer); await provider.close(); },
    async reconcile() { await reconcile(state, policy); },
  };
}
```

### Join-Network Flow [DESIGN SPEC · Phase 3]

```
veil autopilot join
  │
  ├─ 1. Check wallet exists (wallet-identity)
  ├─ 2. Check provider credentials (env vars or config)
  ├─ 3. Query bootstrap for relay list (bootstrap-discovery)
  ├─ 4. Test connectivity to ≥1 relay (network-transport)
  ├─ 5. Register provider with relay (provider-engine)
  ├─ 6. Persist intent to autopilot.json
  ├─ 7. Start reconciliation loop
  └─ 8. Log: "Joined network via {relay}. Provider {pubkey} online."

// Prerequisite failures produce actionable errors:
// - "No wallet found. Run: veil wallet init"
// - "No API key. Set ANTHROPIC_API_KEY or configure provider credentials"
// - "No reachable relays. Check network or bootstrap URL"
```

### Sell-Capacity Strategy Execution [DESIGN SPEC · Phase 4/6]

```ts
async function executeSellStrategy(state: AutopilotState, policy: AutopilotPolicy): Promise<void> {
  for (const model of state.intent.models) {
    const inputs = await gatherPricingInputs(model);  // from provider-engine
    const risk: RiskEnvelope = {
      maxDailyLossQuote: policy.maxDailyLossQuote,
      maxConcurrent: inputs.maxConcurrency,
      minMarginPct: policy.minMarginPct,
      pauseOn429Burst: true,
      burst429Threshold: 5,
      cooldownMs: 60_000,
    };
    const decision = evaluateOffer(inputs, risk);  // pricing-risk-policy
    if (decision.publish) {
      await publishOffers(decision.offers);  // to relay
    } else {
      await withdrawOffers(model);
      log.warn(`Offer withdrawn for ${model}: ${decision.reason}`);
    }
  }
}
```

### Health-Based Pause/Resume [DESIGN SPEC · Phase 3/6]

```ts
async function checkHealth(state: AutopilotState, policy: AutopilotPolicy): Promise<void> {
  const health = await getProviderHealth();  // provider-engine

  if (health.score < policy.healthThreshold && state.status === 'running') {
    state.status = 'paused';
    state.pauseState = { paused: true, reason: 'health_degraded', pausedAt: Date.now() };
    await withdrawAllOffers();
    log.warn('Autopilot paused: health degraded');
  }

  if (health.score > policy.healthThreshold + 0.2 && state.status === 'paused'
      && state.pauseState?.reason === 'health_degraded') {
    state.status = 'running';
    state.pauseState = undefined;
    log.info('Autopilot resumed: health recovered');
  }
}
```

### Reconciliation Loop [DESIGN SPEC · Phase 3/6]

```ts
async function reconcile(state: AutopilotState, policy: AutopilotPolicy): Promise<void> {
  // 1. Check relay connections — reconnect if lost
  for (const conn of state.relayConnections) {
    if (!conn.connected) await reconnectRelay(conn.url, state);
  }

  // 2. Health check
  await checkHealth(state, policy);

  // 3. Re-evaluate sell-side offers (if running)
  if (state.status === 'running') {
    await executeSellStrategy(state, policy);
  }

  // 4. Persist state snapshot
  state.lastReconcileAt = Date.now();
  await persistState(state);
}

// Reconcile interval: 30s default, configurable via policy
// Each reconcile is idempotent — safe to run anytime
```

### CLI Commands [DESIGN SPEC · Phase 3]

```
veil autopilot init       # Create autopilot.json with defaults + guided prompts
veil autopilot join       # Validate prereqs + join network + start loop
veil autopilot show       # Display current state, connections, offers, health
veil autopilot pause      # Manual pause (withdraws offers, stops selling)
veil autopilot resume     # Manual resume (re-enters reconciliation)
veil autopilot stop       # Graceful shutdown (close connections, persist state)

// Config file: ~/.veil/autopilot.json
// State file:  ~/.veil/autopilot-state.json (runtime, not edited by operator)
// Logs:        ~/.veil/logs/autopilot.log
```
