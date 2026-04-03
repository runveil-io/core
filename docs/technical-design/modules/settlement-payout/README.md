# Settlement & Payout

## Purpose

This module defines how witness-backed usage evidence and deterministic quote snapshots become settlement-ready accounting records.

## Responsibility Boundary

- consume witness records and pricing snapshots
- derive deterministic settlement entries
- generate payable balances for Provider and Relay roles
- expose exportable payout instructions without mixing them into contributor accounting

## Out Of Scope

- does not route traffic
- does not invent usage without witness evidence
- does not own contributor grants
- does not force a specific payment rail implementation

## Interface

```ts
type QuoteUnit = 'usd_estimate';

interface SettlementEntry {
  requestId: string;
  pricingVersion: string;
  quoteUnit: QuoteUnit;
  providerQuoteAmount: number;
  relayQuoteAmount: number;
  feesQuoteAmount: number;
  settlementAsset?: string;
  evidenceHash: string;
  dedupeKey: string;
  status: 'quoted' | 'ready' | 'exported';
}

interface PayoutInstruction {
  recipient: string;
  quoteAmount: number;
  settlementAsset: string;
  reason: 'provider' | 'relay';
}

function settleWitness(
  witness: WitnessRecord,
  pricing: PricingSnapshot,
): SettlementEntry;

function buildPayouts(
  entries: SettlementEntry[],
  settlementAsset: string,
): PayoutInstruction[];
```

## Data Flow

Input: witness records, pricing snapshots, role identities, payout windows, settlement-asset mapping.  
Process: validate evidence, compute settlement entries, aggregate payable balances, resolve settlement asset, export payout instructions.  
Output: settlement ledger entries, balances, payout-ready exports.

## State

- persistent: settlement ledger, payout batches, export history
- memory: current aggregation windows, validation caches

## Errors

- missing witness for a requested settlement
- missing pricing snapshot version
- invalid witness signature
- duplicate settlement entry
- missing settlement-asset mapping for export
- payout export mismatch

## Security Constraints

- settlement must never trust opaque side-channel usage
- payout instructions must be reproducible from witness and pricing inputs
- contributor accounting and market settlement must stay on separate ledgers
- quote amounts and settlement assets must remain explicitly distinguishable

## Test Requirements

- deterministic settlement entry generation
- duplicate protection
- invalid witness rejection
- payout aggregation by role
- export reproducibility
- quote-to-settlement export consistency

## Dependencies

- calls: `metering-witness`, `pricing-risk-policy`
- called by: `cli`, `claw-autopilot`

---

## Implementation Details

**Source:** No implementation exists.

## API Specification

No code. See architecture section above for planned interface.

## Integration Protocol

No code. Planned to consume witness records from `relay/witness.ts` WitnessStore and pricing snapshots from a future pricing-risk-policy module.

## Current Implementation Status

- ❌ `settleWitness()` [DESIGN ONLY]
- ❌ `buildPayouts()` [DESIGN ONLY]
- ❌ Settlement ledger [DESIGN ONLY]
- ❌ Payout instruction export [DESIGN ONLY]
- ❌ Deduplication / evidence hash verification [DESIGN ONLY]
- ❌ Quote-to-settlement asset mapping [DESIGN ONLY]

This module is planned for **Phase 5** (Witness-Backed Settlement). No source code exists in `src/`.

---

## Design Specifications for Unimplemented Items

### settleWitness() Flow [DESIGN SPEC · Phase 5]

```ts
function settleWitness(witness: WitnessRecord, pricing: PricingSnapshot): SettlementEntry {
  // 1. Validate witness signature (relay pubkey verify)
  if (!verifyWitnessSignature(witness)) throw new SettlementError('invalid_witness_signature');

  // 2. Validate pricing snapshot exists and version matches
  if (!pricing || pricing.version !== witness.pricingVersion)
    throw new SettlementError('pricing_version_mismatch');

  // 3. Compute evidence hash for deduplication
  const evidenceHash = sha256(witness.requestId + witness.relay_signature + pricing.version);
  const dedupeKey = `settle:${witness.requestId}`;

  // 4. Check duplicate
  if (ledger.has(dedupeKey)) throw new SettlementError('duplicate_settlement');

  // 5. Calculate amounts using pricing snapshot rates
  const totalQuote = (witness.usage.inputTokens * pricing.inputPerM / 1_000_000)
                   + (witness.usage.outputTokens * pricing.outputPerM / 1_000_000);

  // 6. Split: Provider 80%, Relay 10%, Treasury 10%
  return {
    requestId: witness.requestId,
    pricingVersion: pricing.version,
    quoteUnit: pricing.quoteUnit,
    providerQuoteAmount: totalQuote * 0.80,
    relayQuoteAmount:    totalQuote * 0.10,
    feesQuoteAmount:     totalQuote * 0.10,
    evidenceHash,
    dedupeKey,
    status: 'ready',
  };
}
```

### buildPayouts() Distribution Algorithm [DESIGN SPEC · Phase 5]

```ts
function buildPayouts(
  entries: SettlementEntry[],
  settlementAsset: string,
  assetMap: SettlementAssetMap,
): PayoutInstruction[] {
  // 1. Filter only 'ready' entries (skip 'quoted' and 'exported')
  const ready = entries.filter(e => e.status === 'ready');

  // 2. Aggregate by recipient (provider pubkey, relay pubkey)
  const providerTotals = new Map<string, number>();  // pubkey → amount
  const relayTotals = new Map<string, number>();
  let treasuryTotal = 0;

  for (const entry of ready) {
    const rate = assetMap.conversionRate;  // quote → settlement conversion
    accumulate(providerTotals, entry.providerId, entry.providerQuoteAmount * rate);
    accumulate(relayTotals, entry.relayId, entry.relayQuoteAmount * rate);
    treasuryTotal += entry.feesQuoteAmount * rate;
  }

  // 3. Emit payout instructions
  const payouts: PayoutInstruction[] = [];
  for (const [recipient, amount] of providerTotals)
    payouts.push({ recipient, quoteAmount: amount, settlementAsset, reason: 'provider' });
  for (const [recipient, amount] of relayTotals)
    payouts.push({ recipient, quoteAmount: amount, settlementAsset, reason: 'relay' });
  payouts.push({ recipient: 'treasury', quoteAmount: treasuryTotal, settlementAsset, reason: 'relay' });

  // 4. Mark entries as 'exported'
  for (const entry of ready) entry.status = 'exported';
  return payouts;
}
```

### Settlement Ledger Schema [DESIGN SPEC · Phase 5]

```sql
-- settlement.db
CREATE TABLE settlement_entries (
  dedupe_key       TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL,
  pricing_version  TEXT NOT NULL,
  quote_unit       TEXT NOT NULL DEFAULT 'usd_estimate',
  provider_id      TEXT NOT NULL,
  relay_id         TEXT NOT NULL,
  provider_amount  REAL NOT NULL,
  relay_amount     REAL NOT NULL,
  fees_amount      REAL NOT NULL,
  evidence_hash    TEXT NOT NULL,
  status           TEXT NOT NULL CHECK(status IN ('quoted','ready','exported')),
  created_at       INTEGER NOT NULL,
  exported_at      INTEGER
);
CREATE INDEX idx_settlement_status ON settlement_entries(status);
CREATE INDEX idx_settlement_provider ON settlement_entries(provider_id);

CREATE TABLE payout_batches (
  batch_id         TEXT PRIMARY KEY,
  settlement_asset TEXT NOT NULL,
  total_amount     REAL NOT NULL,
  entry_count      INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  exported_at      INTEGER
);
```

### Payout Instruction Export Format [DESIGN SPEC · Phase 5]

```ts
interface PayoutBatch {
  batchId: string;                // uuid v4
  settlementAsset: string;
  instructions: PayoutInstruction[];
  totalAmount: number;
  entryCount: number;
  evidenceHashes: string[];       // for audit trail
  createdAt: number;
}

// Export formats:
// 1. JSON file: payout-batch-{batchId}.json (human-readable audit)
// 2. CSV: payout-batch-{batchId}.csv (payment rail import)
// 3. Signed manifest: sha256 of batch + operator signature for non-repudiation
```

### Integration with metering-witness [DESIGN SPEC · Phase 5]

```
WitnessStore.export(since, until)
  → WitnessRecord[]
  → for each: settleWitness(record, lookupSnapshot(record.pricingVersion))
  → SettlementEntry[] in settlement.db
  → buildPayouts(readyEntries, asset, assetMap)
  → PayoutBatch exported

// Settlement runs as a batch job (CLI: `veil settlement run`)
// Never runs in the inference hot path
// Consumes WitnessStore read-only; never mutates witness data
// Pricing snapshots looked up from pricing-risk-policy snapshot store
```
