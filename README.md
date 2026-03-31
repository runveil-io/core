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
