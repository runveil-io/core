# Pricing & Risk Policy

## Purpose

This module defines how Provider capacity is priced, exposed, paused, or limited in the market.

## Responsibility Boundary

- define provider-side pricing rules and offer floors
- convert operator policy into sell-side limits
- decide whether capacity should be published, repriced, throttled, or paused
- provide deterministic pricing snapshots for witness and settlement consumers

## Out Of Scope

- does not execute inference requests
- does not persist witness records
- does not transfer funds or custody assets
- does not replace Relay admission controls

## Interface

```ts
type QuoteUnit = 'usd_estimate';

interface CapacityOffer {
  model: string;
  capacityUnits: number;
  askQuoteUnitsPerUnit: number;
  quoteUnit: QuoteUnit;
  settlementAssetHint?: string;
}

interface RiskEnvelope {
  maxDailyLossQuote: number;
  maxConcurrent: number;
  pauseOn429Burst: boolean;
}

interface OfferDecision {
  publish: boolean;
  offers: CapacityOffer[];
  reason?: string;
}

function evaluateOffer(
  inputs: PricingInputs,
  risk: RiskEnvelope,
): OfferDecision;
```

## Data Flow

Input: provider capacity, upstream cost signals, health data, operator intent, witness history.  
Process: evaluate margins, apply risk guards, derive active offers, snapshot pricing terms.  
Output: market offers, pause decisions, deterministic pricing snapshots with quote-unit and settlement-asset metadata.

## State

- persistent: policy configuration, pricing snapshots, offer history
- memory: current health signals, recent rate-limit events, cooldown state

## Errors

- missing pricing input for an exposed model
- policy that would sell below configured floor
- stale health data preventing repricing
- inconsistent offer snapshot and witness version
- published offer missing quote-unit or settlement-asset hint

## Security Constraints

- pricing snapshots consumed by settlement must be deterministic and versioned
- risk policy must fail closed on unknown health or cost inputs
- offer publication must not bypass operator guardrails
- quote units must remain distinct from final settlement assets

## Test Requirements

- deterministic pricing for identical inputs
- pause behavior under degraded health
- repricing after cost change
- rejection when required pricing inputs are missing
- snapshot compatibility with witness consumers
- quote and settlement metadata consistency

## Dependencies

- calls: `metering-witness`, `provider-engine`, `claw-autopilot`
- called by: `provider-engine`, `claw-autopilot`, `settlement-payout`

---

## Implementation Details

**Source:** `src/metering/pricing.ts` (partial overlap with metering module)

### Current Implementation

Pricing logic currently lives in the metering module (`src/metering/pricing.ts`). There is no standalone pricing-risk-policy module in `src/`. The design doc describes a future module boundary.

### What Exists in Code

```ts
// src/metering/pricing.ts
const DEFAULT_PRICE_TABLE: Record<string, PriceConfig> = {
  'claude-3-opus':    { inputPerM: 15,   outputPerM: 75   },
  'claude-3-sonnet':  { inputPerM: 3,    outputPerM: 15   },
  'claude-3-haiku':   { inputPerM: 0.25, outputPerM: 1.25 },
  'gpt-4-turbo':      { inputPerM: 10,   outputPerM: 30   },
  'gpt-4':            { inputPerM: 30,   outputPerM: 60   },
  'gpt-3.5-turbo':    { inputPerM: 0.5,  outputPerM: 1.5  },
  'gemini-pro':       { inputPerM: 0.5,  outputPerM: 1.5  },
  'gemini-ultra':     { inputPerM: 7,    outputPerM: 21   },
};

calculateCost(usage: NormalizedUsage, priceConfig: PriceConfig): CostBreakdown
calculateCostByModel(usage: NormalizedUsage, model: string): CostBreakdown
```

### What Does NOT Exist in Code

- `CapacityOffer`, `RiskEnvelope`, `OfferDecision` types
- `evaluateOffer()` function
- Pricing snapshots with versioning
- Sell-side policy enforcement
- Margin calculation
- Pause/resume on health degradation
- Quote-unit / settlement-asset distinction

## API Specification

See metering module for the implemented pricing functions. The dedicated pricing-risk-policy API surface defined in the architecture section is not yet implemented.

## Integration Protocol

- Currently: `calculateCostByModel()` is called by consumer budget tracker
- Future: pricing snapshots would feed into witness records and settlement

## Current Implementation Status

- ✅ Static price table with per-model pricing [IMPLEMENTED] (in metering module)
- ✅ Cost calculation with cache token support [IMPLEMENTED] (in metering module)
- ❌ CapacityOffer / RiskEnvelope types [DESIGN ONLY]
- ❌ evaluateOffer() with margin and risk guards [DESIGN ONLY]
- ❌ Deterministic pricing snapshots [DESIGN ONLY]
- ❌ Sell-side pause/resume policy [DESIGN ONLY]
- ❌ Quote-unit to settlement-asset mapping [DESIGN ONLY]

---

## Design Specifications for Unimplemented Items

### CapacityOffer / RiskEnvelope — Full Type Definitions [DESIGN SPEC · Phase 4]

```ts
interface PricingInputs {
  model: string;
  upstreamCostPerMInput: number;   // actual cost from provider backend
  upstreamCostPerMOutput: number;
  currentConcurrency: number;
  maxConcurrency: number;
  healthScore: number;             // 0.0–1.0, from provider-engine health
  recentWitnessCount: number;      // last 1h completed requests
  recent429Count: number;          // last 15min rate-limit hits
}

interface CapacityOffer {
  model: string;
  capacityUnits: number;           // available concurrent slots
  askQuoteUnitsPerUnit: number;    // price per 1M tokens (input-equivalent)
  quoteUnit: QuoteUnit;            // always 'usd_estimate' for now
  settlementAssetHint?: string;    // e.g. 'USDC', 'USDT' — advisory only
  pricingVersion: string;          // snapshot version for witness linkage
  validUntil: number;              // Unix ms — offer expiry
}

interface RiskEnvelope {
  maxDailyLossQuote: number;       // max daily negative margin in quote units
  maxConcurrent: number;           // hard concurrency cap
  minMarginPct: number;            // reject if margin% below this (e.g. 0.10)
  pauseOn429Burst: boolean;        // auto-pause if >N 429s in window
  burst429Threshold: number;       // N for above (default: 5 in 60s)
  cooldownMs: number;              // pause duration before auto-resume attempt
}
```

### evaluateOffer() Algorithm [DESIGN SPEC · Phase 4]

```ts
function evaluateOffer(inputs: PricingInputs, risk: RiskEnvelope): OfferDecision {
  // 1. Margin calculation
  const marginPct = (inputs.askQuoteUnitsPerUnit - inputs.upstreamCostPerMInput) 
                    / inputs.askQuoteUnitsPerUnit;
  
  // 2. Risk guards (fail closed — reject on ambiguous inputs)
  if (inputs.healthScore < 0.3) return { publish: false, offers: [], reason: 'health_degraded' };
  if (marginPct < risk.minMarginPct) return { publish: false, offers: [], reason: 'below_margin_floor' };
  if (risk.pauseOn429Burst && inputs.recent429Count >= risk.burst429Threshold)
    return { publish: false, offers: [], reason: '429_burst_pause' };

  // 3. Capacity units = max - current (headroom)
  const availableSlots = Math.max(0, risk.maxConcurrent - inputs.currentConcurrency);
  if (availableSlots === 0) return { publish: false, offers: [], reason: 'no_capacity' };

  // 4. Build offer with versioned pricing snapshot
  const offer: CapacityOffer = {
    model: inputs.model,
    capacityUnits: availableSlots,
    askQuoteUnitsPerUnit: inputs.askQuoteUnitsPerUnit,
    quoteUnit: 'usd_estimate',
    pricingVersion: generateSnapshotVersion(),  // deterministic from inputs hash
    validUntil: Date.now() + 300_000,           // 5-minute validity
  };
  return { publish: true, offers: [offer] };
}
```

### Pricing Snapshot Versioning [DESIGN SPEC · Phase 4/5]

```ts
interface PricingSnapshot {
  version: string;               // sha256(model + rates + timestamp_bucket)
  model: string;
  quoteUnit: QuoteUnit;
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM?: number;
  createdAt: number;             // Unix ms
  bucketId: string;              // 5-minute bucket ID for determinism
}

// Versioning rules:
// - Snapshots are bucketed into 5-minute windows for determinism
// - version = sha256(model + inputPerM + outputPerM + bucketId)
// - Settlement consumers reference version string, not raw prices
// - Old snapshots retained for 90 days (settlement reconciliation window)
// - Storage: pricing-snapshots.db with (version TEXT PK, model, rates, created_at)
```

### Sell-Side Pause/Resume Policy [DESIGN SPEC · Phase 4/6]

```ts
interface PauseState {
  paused: boolean;
  reason: 'operator_manual' | 'health_degraded' | '429_burst' | 'margin_floor' | 'daily_loss_limit';
  pausedAt: number;
  resumeAfter?: number;          // auto-resume Unix ms, null = manual only
}

// Policy rules:
// 1. Health < 0.3 for 2 consecutive checks → pause, auto-resume when health > 0.5
// 2. 429 burst (>threshold in 60s) → pause for cooldownMs, then re-evaluate
// 3. Daily loss exceeds maxDailyLossQuote → pause until next UTC day
// 4. Margin below floor → pause, resume when upstream cost changes
// 5. Operator manual pause → only manual resume
// 6. Multiple pause reasons stack; ALL must clear before resume
```

### Quote-Unit to Settlement-Asset Mapping [DESIGN SPEC · Phase 5]

```ts
interface SettlementAssetMap {
  quoteUnit: QuoteUnit;
  settlementAsset: string;       // e.g. 'USDC_POLYGON', 'USDC_BASE'
  conversionRate: number;        // quote-to-asset rate (1.0 for USD→USDC)
  updatedAt: number;
}

// Rules:
// - Quote units (usd_estimate) are budgeting abstractions
// - Settlement assets are concrete tokens on concrete chains
// - Mapping is operator-configured, not auto-derived
// - Default: 1 usd_estimate = 1 USDC (1:1, no conversion)
// - Rate changes create new pricing snapshot versions
// - Payout instructions always reference settlement asset, never quote unit
```
