# Contributing to Veil

You write code. If it passes tests, survives review, and gets merged, it earns auditable contribution credit under RBOB.

## 5-Minute Setup

```bash
git clone https://github.com/runveil-io/core.git
cd core
npm install
npm test
```

You should see all tests passing. If you don't, you found your first contribution.

**Requirements**: Node.js 22+, npm

## How Contribution Accounting Works (RBOB)

Veil uses the **Rule-Based Open Build** protocol. Four rules:

1. **R1** — Code must pass all tests in CI
2. **R2** — Merge requires K independent approvals (currently K=1, Kousan)
3. **R3** — Protected modules (`crypto/`, `wallet/`) require higher threshold
4. **R4** — Surviving code earns points in the contribution ledger.

**What "surviving" means**: your code stays in the codebase and passes tests. Dead code gets pruned, and points go with it.

**Genesis Bonus**: Early contributors earn 5x points. This reflects early-stage build risk and the fact that core system boundaries are still being established.

Points are tracked in the RBOB ledger with a git-auditable contribution trail. Future governance or reward systems should consume the same auditable record, but they are not part of the current runtime contract.

## Finding Work

No separate task board. **The repo is the task board.**

### 1. Failing tests
```bash
npm test -- --reporter=verbose 2>&1 | grep FAIL
```
A failing test is a bounty. Fix it, PR it, earn points.

### 2. Read the code
The codebase is compact enough to inspect directly. If you spot something missing or broken, that's a contribution candidate. Start with [docs/README.md](docs/README.md), then [docs/technical-design/architecture/README.md](docs/technical-design/architecture/README.md) and [docs/technical-design/modules/README.md](docs/technical-design/modules/README.md) to compare the intended boundaries against the current implementation.

### 3. GitHub Issues
Look for labels:
- `good-first-issue` — scoped, tested, documented
- `bounty` — has explicit point value
- `help-wanted` — bigger items that need ownership

### 4. Desired states
Check `desired/` directory (when populated) for feature specs with acceptance criteria and bounty values.

### 5. Use your preferred coding agent

If you work with an agent, point it at `desired/*.yaml`, failing tests, and inline TODOs. The repo already exposes the task sources; the agent does not need a separate control plane.

## Submitting a PR

Keep it simple:

1. **Fork & branch**: `git checkout -b fix/relay-timeout`
   AI agents following [AGENTS.md](AGENTS.md) should use `agent/{task-id}` instead.
2. **Write code + tests**: if you touch `src/`, touch `tests/`
3. **Run tests locally**: `npm test` — all green
4. **Open PR** with:
   - What you changed (1-2 sentences)
   - Which issue/TODO it addresses (if any)
   - Test output showing pass

That's it. No issue template. No commit message convention. No CLA.

### PR Review

- CI runs automatically. Red CI = not reviewed.
- Currently Kousan reviews all PRs (CRL-1 stage).
- Expect review within 24-48 hours.
- Nits are suggestions, not blockers. Ship > perfect.

## What NOT to Touch Without Discussion

These modules are under R3 protection (higher review threshold):

- `src/crypto/` — envelope encryption, key generation
- `src/wallet/` — encrypted storage, KDF
- `src/relay/index.ts` — core identity verification and routing logic
- `package.json` — dependency surface
- `tsconfig.json` — compiler behavior

Open an issue first if you want to modify these. They affect security and economics.

## Code Style

- TypeScript strict mode
- No `any` unless you explain why in a comment
- Tests use vitest
- We don't enforce a formatter yet — just be consistent with surrounding code

## Tech Stack Reference

| Component | Library | Why |
|-----------|---------|-----|
| Runtime | Node.js 22+ | LTS, AI tooling ecosystem |
| Language | TypeScript 5.x | Strict mode, AI agents write it well |
| HTTP | Hono | 3KB, fast |
| WebSocket | ws | Standard |
| Crypto | tweetnacl | Pure JS, zero native deps, audited |
| DB | better-sqlite3 | WAL mode, zero config |
| Tests | vitest | Fast, good DX |
| Build | tsup | Single-file output |

## Architecture (30-second version)

```
Consumer (localhost:9960)
    → encrypts prompt with Provider's public key
    → sends to Relay over WebSocket
    
Relay (configured or discovered endpoint)
    → verifies auth, applies routing policy
    → forwards encrypted blob to Provider
    
Provider (your machine)
    → decrypts prompt
    → calls AI API (OpenAI, Anthropic, etc.)
    → encrypts response, sends back
```

Relay sees routing and witness metadata but not prompt plaintext. Provider sees plaintext execution payload, but it should not receive unnecessary Consumer-side local context.

## Questions?

- [Telegram](https://t.me/+XJ-ogZ9hBy44ZmFl) — fastest response
- GitHub Issues — for anything technical
- use your preferred coding agent if you want help scanning `desired/*.yaml`, failing tests, and TODOs

---

*Your code survives review and stays useful → it earns auditable contribution credit.*
