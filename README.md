# Veil Protocol

**Decentralized AI inference. No account. No identity. Just AI.**

```
$ veil init
$ veil provide start    # Share idle AI capacity, earn USDC
$ veil credits add 10   # Access top AI models, pay with crypto
$ clawd build           # Contribute code, earn future revenue
```

[Website](https://runveil.io) · [Whitepaper](https://runveil.io/whitepaper) · [Twitter](https://x.com/runveil_io) · [Telegram](https://t.me/+XJ-ogZ9hBy44ZmFl) · [GitHub](https://github.com/runveil-io)

---

## Why Veil?

**Your API quota ran out mid-task?** Switch to Veil. Use someone else's idle capacity. Keep working.

```
Direct:  Your App → Your API Key → Anthropic (quota exceeded ❌)
Veil:    Your App → localhost:4000 → Relay → Provider's API → Anthropic ✅
```

Veil runs as a local gateway on port 4000. Your tools (Cursor, OpenClaw, any OpenAI-compatible client) don't know the difference. You pay per token with crypto — cheaper than buying another subscription.

**Your subscription is idle 90% of the time?** Share it. Earn USDC while you sleep.

**You need AI but don't want an account?** Veil is anonymous. No KYC. No tracking. The relay sees who sent a request but can't read it. The provider processes the request but doesn't know who sent it.

---

## What is Veil?

Veil is a decentralized network for AI inference. Three roles:

- **Providers** share idle AI subscription capacity and earn USDC
- **Consumers** access top AI models anonymously with crypto
- **Relays** route encrypted traffic and earn TOKEN

No KYC. No tracking. End-to-end encrypted. Settlement on Solana.

```
Consumer ──> Relay ──> Provider ──> AI Model
    |           |          |
    └────── SOLANA CHAIN ──┘
```

The Relay sees **who** but not **what**. The Provider sees **what** but not **who**.

## Quick Start

### Use AI (Consumer)

```bash
npm install -g veil
veil init
# Point Cursor/Windsurf at http://localhost:9960/v1
```

### Share AI Capacity (Provider)

```bash
veil provide init     # Configure your AI subscription
veil provide start    # Start earning
```

### Run a Relay

```bash
veil relay start      # Route traffic, earn TOKEN
```

## Architecture

```
+------------------+     +------------------+     +------------------+
|    CONSUMER      |     |      RELAY       |     |    PROVIDER      |
|                  |     |                  |     |                  |
| localhost:9960   |---->| Auth + Strip ID  |---->| Decrypt + Infer  |
| OpenAI-compat    |<----| Witness + Route  |<----| Encrypt + Return |
|                  |     |                  |     |                  |
| Encrypt prompt   |     | Can't read       |     | Can't see who    |
| with Provider    |     | prompt content   |     | sent the request |
| public key       |     |                  |     |                  |
+------------------+     +------------------+     +------------------+
                                  |
                          +-------+-------+
                          | SOLANA CHAIN  |
                          | Registry      |
                          | Escrow        |
                          | Settlement    |
                          +---------------+
```

## Build Protocol (RBOB)

Veil builds itself. Four rules. Everything else emerges.

```
R1: Code that passes verification can be merged.
R2: Merge requires K independent stake signatures.
R3: Protected modules require higher threshold.
R4: Surviving code earns future revenue share.
```

Satoshi didn't design mining pools. He wrote rules. An industry emerged.

Linux wasn't planned. Wikipedia wasn't designed. Bitcoin wasn't managed.

They were given rules. The rest emerged.

```bash
$ clawd build         # Your agent scans the repo, finds work, submits PRs
```

## Revenue Model

```
Inference earns USDC ──> Treasury (10%) ──> Build rewards
        ^                                       |
        └──── Better protocol <──── Your contribution
```

- Provider: 80% of transaction value
- Relay: 10%
- Treasury: 10% (funds development + buybacks)

## Tech Stack

- **Runtime**: Node.js 22+ / TypeScript
- **Crypto**: tweetnacl (X25519 + Ed25519)
- **Transport**: WebSocket (QUIC in Stage 2)
- **Chain**: Solana (Stage 2)
- **Tests**: vitest (36/36 passing)

## Project Structure

```
veil-core/
  src/
    consumer/     OpenAI-compatible local gateway
    provider/     Decrypt + API call + encrypt response
    relay/        Auth forwarding + witness recording
    crypto/       Envelope encryption (tweetnacl)
    wallet/       Encrypted keypair storage (scrypt+AES)
    network/      WebSocket with auto-reconnect
    cli.ts        veil init / provide / relay / status
    db.ts         SQLite schema
    types.ts      Wire protocol + API types
  tests/          36 test cases
```

## Security

- **Envelope encryption**: Relay can't read prompt content
- **Dual keypairs**: Separate Ed25519 (signing) + X25519 (encryption)
- **Wallet encryption**: scrypt + AES-256-GCM
- **No code execution**: Provider only forwards HTTP, never executes prompts
- **Relay TOFU**: Official relay pubkey hardcoded

See [Security Threat Model](docs/design/02-security-threat-model.md) for full analysis.

## Status

**Testnet** — Day 1 verified end-to-end:

- [x] Consumer → Relay → Provider → Anthropic → response
- [x] Streaming (SSE, OpenAI-compatible)
- [x] Envelope encryption (Relay can't read prompts)
- [x] Multi-turn conversation
- [x] Error handling (OpenAI-compatible error format)
- [x] 36/36 unit tests passing
- [ ] Multi-provider support
- [ ] On-chain settlement
- [ ] TOKEN economics
- [ ] RBOB build system

## Want to Build?

Veil pays contributors with points, not promises.

**How it works**: Your merged code earns RBOB points. Points are tracked with full git audit trail and convert to TOKEN at TGE. Code that survives in the codebase keeps earning. Code that gets removed stops earning. Simple.

Early contributors get a **5x Genesis Bonus** — compensating for the risk of building before there's a token.

```
Your code passes tests → gets merged → earns points → TGE → points convert to TOKEN
```

### Get Started in 5 Minutes

```bash
git clone https://github.com/runveil-io/core.git
cd core
npm install
npm test    # 36/36 passing
```

### Find Work

- **[Good First Issues](good-first-issues.md)** — 10 scoped tasks with clear acceptance criteria
- `grep -rn "TODO\|FIXME" src/` — every TODO is a contribution opportunity
- Failing tests — if any test is red, fixing it earns points

### Or Let Your Agent Do It

```bash
clawd build    # Scans repo, picks a task, writes code, opens PR
```

### Read More

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, PR process, RBOB details
- [RBOB Protocol](docs/specs/rbob-protocol-v1.md) — the full rule spec


## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.

```bash
$ clawd build    # Let your agent find work and submit PRs
```

Or manually: fork → branch → code → test → PR.

## License

MIT

---

**[runveil.io](https://runveil.io)** · [@runveil_io](https://x.com/runveil_io) · [Telegram](https://t.me/+XJ-ogZ9hBy44ZmFl)

## Contributors

Thanks to everyone building Veil.

| Contributor | PRs | Points | Contributions |
|-------------|-----|--------|---------------|
| [@sami-openlife](https://github.com/sami-openlife) | #15, #16 | 4,500 | Config validation, Structured logging |
| [@597226617](https://github.com/597226617) | #11 | 2,500 | CLI colors & spinner |
| [@hopkdj](https://github.com/hopkdj) | #12 | 1,500 | Provider health endpoint |
| [@Chronolapse411](https://github.com/Chronolapse411) | #14 | *under review* | Multi-provider selector |

*Points include 5x Genesis Bonus (early contributor multiplier).*
*Points convert to TOKEN at TGE.*
