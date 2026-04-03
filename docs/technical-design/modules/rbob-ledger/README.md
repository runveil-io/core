# RBOB Ledger

## Purpose

This module records open-source contribution grants and exposes auditable ledger queries.

## Responsibility Boundary

- store contribution points
- sign ledger entries with an admin key
- verify ledger entries
- export balances and leaderboard data

## Out Of Scope

- does not participate in inference routing
- does not replace production witness records
- does not manage contributor identity beyond ledger needs

## Interface

```ts
class RbobLedger {
  grant(
    params: GrantParams,
    adminSecretKey: Uint8Array,
    adminPublicKey: Uint8Array,
  ): LedgerEntry;
  verifyEntry(entry: LedgerEntry, adminPublicKey: Uint8Array): boolean;
  balance(contributor: string): BalanceResult;
  leaderboard(limit?: number): LeaderboardEntry[];
  exportJSON(): TokenClaimExport;
}
```

## Data Flow

Input: contributor identity, points, reason, PR reference.  
Process: validate grant, sign message, insert ledger entry, query totals.  
Output: signed contribution records and export payloads.

## State

- persistent: `rbob_ledger`
- memory: query results and export objects

## Errors

- non-positive points
- missing contributor
- missing reason
- invalid signature verification

## Security Constraints

- admin signatures are the trust anchor
- contribution accounting must stay separate from production witness accounting

## Test Requirements

- grant, verify, balance, leaderboard, export
- invalid grant rejection

## Dependencies

- calls: `crypto`
- called by: `cli`, maintainers

---

## Implementation Details

**Source:** `src/rbob/ledger.ts`, `src/rbob/types.ts`, `src/rbob/index.ts`

### Key Data Structures

```ts
// src/rbob/types.ts
interface LedgerEntry {
  id: number;
  contributor: string;
  pr_number: number | null;
  points: number;
  multiplier: number;
  reason: string;
  admin_signature: string | null;
  timestamp: number;
}

interface BalanceResult {
  contributor: string;
  total_points: number;
  entries: number;
}

interface LeaderboardEntry {
  rank: number;
  contributor: string;
  total_points: number;
  contributions: number;
}

interface GrantParams {
  contributor: string;
  points: number;
  reason: string;
  pr_number?: number;
  multiplier?: number;
}

interface TokenClaimExport {
  version: 1;
  exported_at: string;
  entries: Array<{ contributor; pr_number; points; multiplier; reason; timestamp }>;
  totals: Array<{ contributor; total_points }>;
}
```

### Core Flow

1. **Grant**: validate params (positive points, non-empty contributor/reason) → apply multiplier → sign message `contributor|points|multiplier|reason|timestamp` with Ed25519 → insert into SQLite
2. **Verify**: reconstruct signable message from entry fields → `nacl.sign.detached.verify()` against admin pubkey
3. **Balance**: `SUM(points)` + `COUNT(*)` grouped by contributor
4. **Leaderboard**: `SUM(points)` ordered DESC, limited
5. **Export**: all entries (ASC by timestamp) + per-contributor totals for on-chain migration

### DB Schema

```sql
CREATE TABLE rbob_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contributor TEXT NOT NULL,
  pr_number INTEGER,
  points INTEGER NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1.0,
  reason TEXT NOT NULL,
  admin_signature TEXT,
  timestamp INTEGER NOT NULL
);
-- Indexes: idx_rbob_contributor, idx_rbob_timestamp, idx_rbob_pr
```

### State Management

- **Persistent**: SQLite with WAL mode, stored at `~/.veil/data/rbob.db`
- **In-memory**: query results only, no caching

### Error Handling

- Points ≤ 0 → throw `'Points must be positive'`
- Missing contributor → throw `'Contributor is required'`
- Missing reason → throw `'Reason is required'`
- Signature verification failure → returns `false`

## API Specification

```ts
class RbobLedger {
  constructor(dbPath: string)
  grant(params: GrantParams, adminSecretKey: Uint8Array, adminPublicKey: Uint8Array): LedgerEntry
  verifyEntry(entry: LedgerEntry, adminPublicKey: Uint8Array): boolean
  balance(contributor: string): BalanceResult
  leaderboard(limit?: number): LeaderboardEntry[]  // default 20
  history(contributor: string): LedgerEntry[]
  exportJSON(): TokenClaimExport
  close(): void
}
```

## Integration Protocol

- **Called by CLI**: `veil rbob balance/leaderboard/grant/export`
- **Crypto dependency**: `sign()` and `verify()` from `src/crypto/index.ts` for Ed25519 signatures
- **DB**: independent SQLite database, separate from relay witness DB
- **Export format**: designed for future on-chain token claim migration

## Current Implementation Status

- ✅ Grant with Ed25519 admin signature [IMPLEMENTED]
- ✅ Signature verification [IMPLEMENTED]
- ✅ Balance and leaderboard queries [IMPLEMENTED]
- ✅ Contribution history per contributor [IMPLEMENTED]
- ✅ JSON export with totals [IMPLEMENTED]
- ✅ Multiplier support [IMPLEMENTED]
- ✅ PR number tracking [IMPLEMENTED]
- ❌ On-chain token claim submission [DESIGN ONLY]
- ❌ Multi-admin signature support [DESIGN ONLY]
- ❌ Contributor identity linking to wallet pubkeys [DESIGN ONLY]

---

## Design Specifications for Unimplemented Items

### On-Chain Token Claim Submission [DESIGN SPEC · Phase 5]

```ts
interface ClaimRequest {
  contributorId: string;
  walletAddress: string;           // EVM address for token receipt
  claimAmount: number;             // RBOB points to claim
  balanceProof: string;            // signed: "claim:{id}:{amount}:{nonce}"
  nonce: number;                   // monotonic, prevents replay
}

interface ClaimReceipt {
  claimId: string;
  txHash?: string;                 // on-chain tx hash (after submission)
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  submittedAt?: number;
}

// Flow:
// 1. Contributor links wallet (see identity linking below)
// 2. CLI: veil rbob claim --amount 100
// 3. System verifies balance >= amount, generates signed ClaimRequest
// 4. Claim exported as JSON (for manual submission) or submitted via RPC
// 5. On-chain contract verifies admin signature + nonce
// 6. Points deducted from ledger balance on confirmation
//
// Constraints:
// - Minimum claim: 10 RBOB points
// - Max 1 claim per contributor per 24h
// - Failed claims: nonce not incremented, can retry
// - RBOB ledger and inference settlement are separate ledgers (never mixed)
```

### Multi-Admin Signature Support [DESIGN SPEC · Phase 5]

```ts
interface AdminGrant {
  grantId: string;
  contributor: string;
  points: number;
  reason: string;
  signatures: { adminId: string; signature: string }[];
  requiredSignatures: number;      // e.g. 2-of-3
  status: 'pending' | 'approved' | 'rejected';
}

// Rules:
// - Grant requires N-of-M admin signatures (configurable, default 1-of-1)
// - Each admin signs: "grant:{grantId}:{contributor}:{points}:{reason}"
// - Grant applied to ledger only when requiredSignatures met
// - Admin list stored in rbob-config.json (pubkeys)
// - Admin add/remove requires existing admin majority signature
// - Audit: all grants with partial signatures visible in export
```

### Contributor Identity Linking to Wallet Pubkeys [DESIGN SPEC · Phase 5]

```ts
interface IdentityLink {
  contributorId: string;           // GitHub username or internal ID
  walletPubkey: string;            // Ed25519 pubkey from wallet-identity
  evmAddress?: string;             // for on-chain claims
  linkProof: string;               // signed by wallet: "link:{contributorId}:{pubkey}"
  linkedAt: number;
}

// Flow:
// 1. CLI: veil rbob link --contributor github:username
// 2. Wallet signs link proof
// 3. Stored in rbob.db identity_links table
// 4. Required before on-chain claims (must know where to send tokens)
// 5. One contributor can link multiple wallets (e.g. rotation)
// 6. Unlinking: requires wallet signature + admin approval
```
