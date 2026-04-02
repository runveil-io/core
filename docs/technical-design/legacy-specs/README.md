# Legacy Design Specifications

These are the original detailed design documents from Veil's Day 1 implementation phase.

## Status: Archived

These documents are preserved as implementation reference while the documentation is being restructured into the new taxonomy under `docs/product-design/` and `docs/technical-design/modules/`.

**Do not update these files.** New design work should go into the corresponding module README under `docs/technical-design/modules/`.

## Contents

| File | Module | Key Content |
|------|--------|-------------|
| `00-architecture-review-v0.2.md` | System Model | Role definitions, trust assumptions, data flow |
| `02-security-threat-model.md` | Trust & Privacy | Assets, boundaries, attack surfaces, controls |
| `03-metering-billing.md` | Metering & Witness | Usage normalization, pricing, settlement design |
| `04-crypto-envelope.md` | Wallet & Identity | X25519, ChaCha20-Poly1305, seal/open, zeroize |
| `05-consumer-gateway.md` | Consumer Gateway | OpenAI-compatible API, provider selection, streaming |
| `06-provider-engine.md` | Provider Engine | Upstream adapters, account pool, usage extraction |
| `07-relay-routing.md` | Relay | provider_hello, consumer_hash, witness schema, rate limits |
| `08-network-transport.md` | Network Transport | WebSocket reconnect, heartbeat, message framing |
| `09-wallet-identity.md` | Wallet & Identity | Key generation, encrypted storage, argon2id KDF |
| `10-cli-ux.md` | CLI | Command structure, daemon management |
| `11-wire-protocol.md` | Protocol | Message types, signing payloads, version negotiation |
| `12-anti-detection.md` | *(removed from public design)* | Account rotation, fingerprint randomization |
| `13-rbob-scoring.md` | RBOB Ledger | Points calculation, genesis bonus, anti-gaming |
| `14-task-lifecycle.md` | *(future)* | Probe, multi-turn, failover, budget warning |

## Migration Plan

Key implementation specs from these files will be gradually migrated into the new module READMEs:
1. Crypto primitives → `modules/wallet-identity/`
2. Wire protocol messages → `protocol/`
3. Relay witness schema → `modules/relay/` + `modules/metering-witness/`
4. Task lifecycle state machine → future `modules/task-lifecycle/`
