# AGENTS.md — For AI Agents

## Setup

```
git clone https://github.com/runveil-io/core.git && cd core
npm install
npm test
```

## Find Work

1. Parse `desired/*.yaml` — pick any file where `status: open`
2. `npm test -- --reporter=verbose 2>&1 | grep FAIL` — failing tests are tasks
3. `grep -rn "TODO" src/` — inline TODOs are tasks

Priority: desired/ files first (they have points), then failing tests, then TODOs.

## Submit

1. Fork `runveil-io/core`
2. Branch: `agent/{task-id}` (e.g. `agent/provider-health-check`)
3. Write code, run `npm test`, confirm all tests pass
4. Push branch, open PR against `main`
5. PR title: `[RBOB] {task title}`
6. PR body: reference the desired/ file id

## RBOB Rules

```
R1: All tests must pass (npm test exits 0).
R2: Merge requires K=1 approval (currently: maintainer review).
R3: Protected modules require maintainer review (see below).
R4: Points awarded on merge. Genesis contributors get 5x bonus.
```

## Protected Modules

These paths require explicit maintainer approval. Do not modify without review:

- `src/crypto/` — cryptographic primitives
- `src/wallet/` — key management and signing
- `src/relay/index.ts` — identity verification and routing logic (non-rate-limit core)
- `package.json` — dependency changes
- `tsconfig.json` — compiler config

## File Structure

```
src/
  cli.ts              — CLI entry point
  db.ts               — SQLite database
  types.ts            — Shared type definitions
  logger.ts           — Structured logging
  config/
    bootstrap.ts      — Bootstrap and config loading
    validator.ts      — Config validation
  consumer/
    index.ts          — Consumer client
    anthropic-stream.ts — Anthropic SSE streaming
    selector.ts       — (desired) Provider selection
  provider/
    index.ts          — Provider HTTP server
    metrics.ts        — Performance metrics
  relay/
    index.ts          — Relay server
  proxy/
    index.ts          — Local proxy server
  crypto/
    index.ts          — X25519, ChaCha20, signing
  wallet/
    index.ts          — Key generation, config persistence
  network/
    index.ts          — WebSocket client with reconnect

tests/
  consumer.test.ts
  crypto.test.ts
  e2e.test.ts
  network.test.ts
  provider.test.ts
  relay.test.ts
  wallet.test.ts
```

## Tech Stack

- Node.js 22, TypeScript, ESM
- tweetnacl — cryptography
- Hono — HTTP server (provider, relay)
- better-sqlite3 — local database
- vitest — test runner
- tsup — bundler

## Test Commands

```
npm test                          # run all tests
npx vitest run tests/provider     # run one suite
npx vitest run --reporter=verbose # verbose output
```
