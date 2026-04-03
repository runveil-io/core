# Roadmap

## Purpose

This section describes the staged delivery order for Veil. It is a forward-looking implementation sequence.

Everything in this section is roadmap scope unless another section explicitly marks it as already implemented.

## Planning Rule

Each phase should leave the system more operable and more verifiable than before. New capability should not outrun protocol clarity, security boundaries, or runtime visibility.

Use [Execution Rules](./execution-rules.md) as the hard dependency and phase-gate reference when turning this roadmap into implementation tasks.
Use [Product Vision](../../design-governance/product-vision.md) as the product constraint source when deciding what must remain on the main path.

## North Star

The target Veil operator experience is:

1. tell Claw to join the network
2. tell Claw to start selling available inference capacity
3. let the system keep the node online, priced, routed, witnessed, and recoverable with minimal manual intervention

## Planning Tracks

- `Autopilot`: remove manual node lifecycle work
- `Marketplace`: turn capacity into sellable network supply
- `Settlement`: move from witness records and quote units to payout-capable, crypto-compatible accounting
- `Privacy`: keep accountless, privacy-preserving routing while the market loop grows

## Version Strategy

| Version | Scope | Gate Criteria | External Message |
|---------|-------|---------------|------------------|
| v0.1-alpha | Phase 1 | Runtime baseline works end-to-end | "Testnet alpha — developers can try the Consumer→Relay→Provider path" |
| v0.5-beta | Phase 1-2 | Multi-relay discovery, network is decentralized | "Public beta — Providers can be discovered, Consumers can choose supply" |
| v0.8-RC | Phase 1-3 | Operator automation, one-command join | "Release candidate — Providers can join and earn with guided automation" |
| v1.0 | Phase 1-5 | Settlement works, money flows | "Production — complete marketplace with witness-backed settlement" |
| v1.x | Phase 6-7 | Low-touch ops, advanced privacy | Post-launch iteration |

---

## Phase 1: Reliable Runtime Baseline

**Target version: v0.1-alpha**

### Goals

- stabilize the local Consumer gateway as the default accountless entry point
- stabilize Relay to Provider request forwarding
- keep witness, budget, and error flows usable for real Consumer to Provider paths

### Concrete Deliverables

- [ ] Consumer gateway serves OpenAI-compatible `/v1/chat/completions` (streaming + non-streaming)
- [ ] `GatewayOptions` interface aligned to architecture (`relayMode`, `quoteUnit`, `defaultQuoteBudget`)
- [ ] E2E encryption (nacl.box seal/open) on all Consumer↔Provider payloads
- [ ] Per-request budget guard with quote-unit tracking
- [ ] Relay verifies, strips identity, forwards, and records witness
- [ ] Witness record format aligned to architecture (camelCase, nested `usage`, `evidenceHash`)
- [ ] Provider decrypts, executes upstream inference, returns encrypted response
- [ ] Wallet create/load/export with scrypt+AES-256-GCM encryption
- [ ] CLI covers full lifecycle: `veil init`, `veil start`, `veil provide`, `veil relay`
- [ ] 245+ tests passing, build clean
- [ ] README, CONTRIBUTING, desired/*.yaml reflect true project state
- [ ] E2E test covers real Consumer→Relay→Provider success path with strict assertions

### Code Alignment Tasks (31 total)

See each module's `Code Alignment Tasks` section in `docs/technical-design/modules/*/README.md`.

Key areas:
- consumer-gateway: 9 tasks (GatewayOptions interface, relayMode, quoteUnit)
- metering-witness: 9 tasks (WitnessRecord restructure, PricingSnapshot, QuoteEstimate)
- provider-engine: 6 tasks (multi-relay, relayMode)
- cli: 4 tasks (downstream interface alignment)
- relay: 3 tasks (witness consolidation, RelayWitness type)

### Gate Criteria

- `npm test` all green
- `npm run build` clean
- E2E: Consumer sends request → Relay forwards → Provider executes → Consumer receives response (not 5xx tolerance)
- Witness record written and verifiable
- Budget guard rejects over-budget request
- Documentation matches code interfaces

---

## Phase 2: Discovery And Multi-Relay Reachability

**Target version: v0.5-beta**

### Goals

- mature Bootstrap and Relay discovery
- support better Relay selection
- improve multi-Relay Provider reachability
- make available Provider supply easier for Consumers to discover and use

### Concrete Deliverables

- [ ] Bootstrap server supports multi-region Relay registration
- [ ] Discovery client selects Relay by latency + fee + uptime scoring (already partial)
- [ ] Consumer can failover between multiple Relays automatically
- [ ] Provider can register with multiple Relays simultaneously
- [ ] `relayMode: 'bootstrap'` fully operational with automatic discovery
- [ ] Relay health check probes from Bootstrap (stale detection + pruning)
- [ ] Relay banning/unbanning workflow (auto-ban on repeated failures, manual unban)
- [ ] Public Bootstrap endpoint documented for external Relay operators

### Gate Criteria

- Consumer discovers and connects to best available Relay without manual configuration
- Provider registers with 2+ Relays and serves requests from either
- Relay goes offline → Consumer automatically fails over to next Relay within 5s
- Bootstrap prunes stale Relays within 90s

---

## Phase 3: Guided Operator Automation

**Target version: v0.8-RC**

### Goals

- harden runtime limits and connection behavior
- strengthen Relay and Provider health management
- tighten secret handling and operator workflows
- make running a Provider safer and more predictable as an economic role
- add the first Claw-managed join and startup flow so operators no longer need to hand-assemble every runtime step

### Concrete Deliverables

- [ ] `veil autopilot init` — configure operator intent (models, pricing, risk policy)
- [ ] `veil autopilot join` — automated join-network flow (wallet check → bootstrap discover → relay connect → provider register → health verify)
- [ ] `veil autopilot show` — display current autopilot state, connected relays, capacity, earnings
- [ ] `veil autopilot pause/resume/stop` — lifecycle management
- [ ] Health-based auto-pause (error rate > threshold → pause → resume when healthy)
- [ ] Reconciliation loop (reconnect dropped relays, re-register, persist state)
- [ ] Credential rotation without restart (hot-swap API keys)
- [ ] Connection multiplexing for multi-relay efficiency
- [ ] TLS configuration (strict/permissive modes)
- [ ] Operator intent stored in config, not code

### Gate Criteria

- New operator runs `veil autopilot init && veil autopilot join` and is serving requests within 60s
- Provider auto-pauses on upstream API errors, auto-resumes when healthy
- Relay disconnect → Provider reconnects within 30s without manual intervention
- Credential rotation completes without dropping in-flight requests

---

## Phase 4: Autonomous Marketplace Control

**Target version: part of v1.0 path**

### Goals

- improve replay protection and request contracts
- strengthen usage and witness evidence
- improve protocol versioning and compatibility
- introduce policy-driven capacity publication and pricing controls
- let Claw keep sell-side policy, health, and recovery aligned without constant operator intervention

### Concrete Deliverables

- [ ] `CapacityOffer` type — Provider publishes available models, pricing, limits
- [ ] `RiskEnvelope` type — margin thresholds, max exposure, pause triggers
- [ ] `evaluateOffer()` — automated offer evaluation with margin calc + risk guards
- [ ] Deterministic pricing snapshots with version IDs (5-min buckets)
- [ ] Sell-side pause/resume policy (upstream error, margin breach, manual override)
- [ ] Replay protection (request nonce + TTL + dedup)
- [ ] Protocol version negotiation between Consumer/Relay/Provider
- [ ] Capacity publication: Provider → Relay → Bootstrap → discoverable by Consumer
- [ ] Multi-provider backend support (beyond Anthropic: OpenAI, Google, local models)
- [ ] Dynamic pricing based on supply/demand signals

### Gate Criteria

- Provider publishes capacity offer → Consumer discovers and selects by model+price
- Pricing adjusts when supply changes (Provider goes offline → price rises)
- Duplicate request rejected by nonce dedup
- Protocol version mismatch → graceful rejection with upgrade message

---

## Phase 5: Witness-Backed Settlement

**Target version: v1.0 (production)**

### Goals

- keep governance and inference accounting aligned but separate
- mature contribution accounting and export flows
- make pricing and witness-backed settlement interfaces usable
- separate quote units used for budgeting from settlement assets used for payment rails
- prepare cleaner interfaces for payment rails and Provider or Relay payout systems
- keep crypto-native settlement on the main path instead of treating it as an optional add-on
- align the product market loop and the open-source build loop without collapsing them into one ledger

### Concrete Deliverables

- [ ] `settleWitness()` — verify witness signatures → match pricing snapshot → compute evidence hash → dedup → split 80/10/10
- [ ] `buildPayouts()` — aggregate by recipient, convert quote→settlement asset, generate payout instructions
- [ ] Settlement ledger (SQLite: `settlement_entries` + `payout_batches` tables)
- [ ] Payout instruction export (JSON + CSV + signed manifest)
- [ ] Quote-unit to settlement-asset mapping (operator-configured, default 1:1 USDC)
- [ ] RBOB on-chain token claim flow (nonce-protected)
- [ ] Multi-admin N-of-M grant signatures for RBOB
- [ ] Contributor identity linking to wallet pubkeys
- [ ] Settlement audit trail: every payout traceable to witness records
- [ ] Metering witness and relay witness unified into single architecture-defined format

### Gate Criteria

- Consumer pays → Provider serves → Witness recorded → Settlement computed → Provider receives 80% payout instruction
- Duplicate witness rejected by evidence hash dedup
- Settlement export verifiable by third party using public keys
- RBOB contributor can claim earned points against on-chain token
- Full audit trail: request → witness → settlement entry → payout batch

---

## Phase 6: Low-Touch Market Operation

**Target version: v1.x**

### Goals

- let Claw operate Provider nodes in a near-autonomous mode
- automate repricing, pause and resume behavior, and sell-side risk envelopes
- reduce manual configuration to operator intent, policy guardrails, and credential approval

### Concrete Deliverables

- [ ] Claw autopilot manages full Provider lifecycle without operator intervention
- [ ] Automatic repricing based on margin performance and market signals
- [ ] Sell-side risk envelope auto-adjustment (widen on good performance, tighten on losses)
- [ ] Earnings dashboard with projected revenue and cost breakdown
- [ ] Operator notification system (alerts on pause, revenue milestones, health events)
- [ ] Multi-node management from single operator identity

### Gate Criteria

- Provider runs 7 days without manual intervention
- Pricing adjusts automatically when upstream costs change
- Operator receives actionable notifications, not noise

---

## Phase 7: Optional Advanced Privacy Profile

**Target version: v1.x**

### Goals

- explore a stronger privacy profile only after the marketplace loop works operationally
- separate the standard marketplace profile from any future anonymity-heavy profile
- avoid letting anonymity claims outrun the guarantees of the deployed system

### Concrete Deliverables

- [ ] HSM/hardware key support for wallet identity
- [ ] Key rotation without identity change (proof chain)
- [ ] Per-request consumer identity rotation (beyond daily-salt hash)
- [ ] On-chain witness export with Merkle tree batches
- [ ] Cross-relay witness verification protocol
- [ ] Binary frame support for reduced metadata leakage
- [ ] Privacy audit: document exactly what each role can observe

### Gate Criteria

- Privacy audit published with honest boundaries
- Standard profile and advanced profile clearly separated in configuration
- No anonymity claims that outrun deployed guarantees
