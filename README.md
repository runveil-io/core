# Veil

Veil is an open-source AI capacity marketplace being built in stages. Today it runs as an AI inference routing runtime for accountless, OpenAI-compatible access to Provider-supplied capacity, with Relay-based routing and signed witness recording.

## Overview

Veil lets existing OpenAI-compatible clients call a local gateway while routing execution through Relay and Provider nodes. The runtime is the delivery layer for a larger product goal: Consumers get accountless access to AI capacity, Providers expose spare capacity as routable supply, Relays broker traffic without becoming the execution endpoint, and Claw becomes the low-touch automation surface for joining and operating the network.

## Design Goals

- keep existing OpenAI-compatible clients working
- make AI access possible without wiring every tool directly to every upstream account
- turn spare Provider-side capacity into reusable network supply
- route around single-account or single-provider bottlenecks
- separate routing visibility from execution visibility
- preserve witness and accounting boundaries for later reconciliation
- keep crypto-compatible settlement on the main roadmap without making the runtime chain-first

## Runtime Roles

- `Consumer`: local gateway and request origin
- `Relay`: verification, routing, limits, and witness
- `Provider`: upstream execution and streaming response delivery
- `Bootstrap`: Relay discovery service

The target marketplace runtime adds `Claw` as the operator automation surface for join, sell, pause, and recovery workflows.

## Supporting Systems

- `RBOB`: open-source contribution accounting

## Request Path

```text
Client -> Consumer Gateway -> Relay -> Provider -> Upstream AI
                     \-> Budget      \-> Witness
Bootstrap -> Relay discovery
RBOB -> contribution accounting
```

## What You Get

- exposes a local gateway for existing AI clients
- allows callers to consume AI access through Veil instead of binding every client directly to an upstream account
- routes encrypted requests through Relay nodes
- lets Providers contribute routable AI capacity
- executes requests on Provider nodes
- records witness data for stats, export, and later reconciliation
- keeps contribution accounting separate from production inference traffic

## Product Model

- `Consumer`: wants reliable AI access through one local interface, without forcing every tool to manage every upstream account directly
- `Provider`: contributes spare AI quota or API capacity and serves inference inside the execution boundary
- `Relay`: brokers routing, admission, and witness without becoming the model execution host
- `Claw`: becomes the supported automation layer for onboarding, policy application, and sell-side operation
- `Contributors`: improve the protocol and runtime through the open-source build loop

## Current Status

- implemented today: local Consumer gateway, Relay routing, Provider execution, witness export, wallet management, Relay discovery, and RBOB contribution accounting
- planned next: quote-aware pricing interfaces, settlement evidence contracts, payment-rail adapters, and Provider or Relay payout surfaces
- long-term target: Claw-managed network join, low-touch Provider operation, policy-driven selling, and witness-backed, crypto-compatible settlement

## Quick Start

```bash
git clone https://github.com/runveil-io/core.git
cd core
npm install
npm test
```

Initialize a local wallet:

```bash
veil init
```

Run a Provider:

```bash
veil provide init
veil provide start
```

Run a Relay:

```bash
veil relay start
```

Use the local gateway:

```bash
# OpenAI-compatible endpoint
http://localhost:9960/v1
```

## Documentation

- Docs home: [docs/README.md](docs/README.md)
- 中文入口: [docs/README.zh.md](docs/README.zh.md)
- Design governance: [docs/design-governance/README.md](docs/design-governance/README.md)
- Product design: [docs/product-design/README.md](docs/product-design/README.md)
- Trust and privacy: [docs/product-design/trust-and-privacy/README.md](docs/product-design/trust-and-privacy/README.md)
- Install and run: [docs/installation/README.md](docs/installation/README.md)
- Daily operations: [docs/manual/README.md](docs/manual/README.md)
- Configuration: [docs/technical-design/configuration/README.md](docs/technical-design/configuration/README.md)
- Client integration: [docs/clients/README.md](docs/clients/README.md)
- Architecture: [docs/technical-design/architecture/README.md](docs/technical-design/architecture/README.md)
- Module specs: [docs/technical-design/modules/README.md](docs/technical-design/modules/README.md)

For protocol behavior, operations, and implementation boundaries, continue from [docs/README.md](docs/README.md).

## Repository Layout

```text
src/
  bootstrap/     Relay registry service
  config/        bootstrap and validation
  consumer/      local gateway and budget guard
  crypto/        signing and sealed payload handling
  discovery/     Relay discovery client
  metering/      usage normalization and pricing
  network/       WebSocket transport
  provider/      upstream execution engine
  proxy/         local secret-holding upstream proxy
  rbob/          contribution ledger
  relay/         routing, rate limit, witness
  wallet/        encrypted wallet and secrets
  cli.ts         command entry
tests/           unit and integration tests
docs/            project documentation
```

## Runtime Defaults

- default gateway port: `9960`
- default Relay port: `8080`
- default Provider health port: `9962`
- default proxy port: `4000`
- transport: WebSocket
- runtime: Node.js 22 + TypeScript

## Security Boundaries

- Relay forwards sealed request payloads without decrypting them
- Provider decrypts only inside the execution boundary
- signing keys and encryption keys are separate
- wallet files and Provider credentials are encrypted at rest
- Veil is privacy-preserving by design, but it does not claim perfect anonymity against traffic analysis, endpoint compromise, or colluding operators

## Development

Read [CONTRIBUTING.md](CONTRIBUTING.md) and `desired/*.yaml` before starting work.

Useful commands:

```bash
npm test
npx vitest run --reporter=verbose
grep -rn "TODO\\|FIXME" src/
```

## Community

Veil is an open-source project built in public. That only works if maintainers, reviewers, and contributors are visible parts of the project surface.

- Website: [runveil.io](https://runveil.io)
- GitHub: [runveil-io](https://github.com/runveil-io)
- X: [@runveil_io](https://x.com/runveil_io)
- Telegram: [community chat](https://t.me/+XJ-ogZ9hBy44ZmFl)
- start with [CONTRIBUTING.md](CONTRIBUTING.md)
- use `desired/*.yaml`, failing tests, and inline TODOs to find work
- open issues or pull requests when you want to improve a module, document a bug, or propose a change

## Contributors

Thanks to everyone building Veil.

| Contributor | PRs | Points | Contributions |
|-------------|-----|--------|---------------|
| [@Chronolapse411](https://github.com/Chronolapse411) | #30, #31, #33 | 7,500 | Rate limiting, Consumer retry, Provider metrics |
| [@sami-openlife](https://github.com/sami-openlife) | #15, #16 | 4,500 | Config validation, Structured logging |
| [@597226617](https://github.com/597226617) | #11, #50 | 5,000 | CLI colors and spinner, Metering module |
| [@grit-web3-agency](https://github.com/grit-web3-agency) | #54 | 2,500 | RBOB points ledger |
| [@hopkdj](https://github.com/hopkdj) | #12 | 1,500 | Provider health endpoint |

Points reflect the repository's contribution accounting model, including the early contributor multiplier where applicable.

## License

MIT
