# Veil Docs

This directory is the canonical documentation entry for Veil.

Veil is being built as an agent-operated AI capacity marketplace. Today the canonical runtime surface is an AI inference routing system with four primary runtime roles:

- `Consumer`: local OpenAI-compatible gateway
- `Relay`: verification, routing, limits, and witness
- `Provider`: upstream execution
- `Bootstrap`: Relay discovery

The target market surface adds Claw automation, sell-side policy, and settlement flows on top of this runtime baseline.

## Choose A Path

- New to the project:
  [Overview](./product-design/overview/README.md) -> [Product Design](./product-design/README.md) -> [Design Governance](./design-governance/README.md) -> [Technical Design](./technical-design/README.md)
- Installing or operating Veil:
  [Installation](./installation/README.md) -> [Manual](./manual/README.md) -> [Operations](./operations/README.md)
- Configuring nodes:
  [Configuration](./technical-design/configuration/README.md)
- Integrating clients or tools:
  [Clients](./clients/README.md)
- Understanding trust and privacy boundaries:
  [Trust and Privacy](./product-design/trust-and-privacy/README.md)
- Implementing or reviewing protocol behavior:
  [Protocol](./technical-design/protocol/README.md)
- Working on contribution accounting or governance:
  [Governance and Economics](./product-design/governance-and-economics/README.md) -> [Roadmap](./product-design/roadmap/README.md)
  Use [execution-rules.md](./product-design/roadmap/execution-rules.md) when sequencing implementation work.

## System At A Glance

```text
Client -> Consumer Gateway -> Relay -> Provider -> Upstream AI
                     \-> Budget      \-> Witness
Bootstrap -> Relay discovery
RBOB -> contribution accounting
```

## Documentation Sections

- [product-design/](./product-design/README.md): product scope, trust and privacy stance, governance economics, and roadmap
- [technical-design/](./technical-design/README.md): system model, architecture, modules, protocol, and runtime configuration
- [design-governance/](./design-governance/README.md): product vision and traceability governance
  See also [documentation-governance-rules.md](./design-governance/documentation-governance-rules.md) for classification and maintenance standards.
- [clients/](./clients/README.md): local gateway integration guides
- [operations/](./operations/README.md): deployment, persistence, limits, observability
- [manual/](./manual/README.md): role-based runtime usage
- [installation/](./installation/README.md): setup and first-time environment preparation
- [glossary/](./glossary/README.md): stable public terminology

## Module Index

The module docs are organized by implementation boundary:

- [wallet-identity](./technical-design/modules/wallet-identity/README.md)
- [consumer-gateway](./technical-design/modules/consumer-gateway/README.md)
- [network-transport](./technical-design/modules/network-transport/README.md)
- [relay](./technical-design/modules/relay/README.md)
- [provider-engine](./technical-design/modules/provider-engine/README.md)
- [metering-witness](./technical-design/modules/metering-witness/README.md)
- [bootstrap-discovery](./technical-design/modules/bootstrap-discovery/README.md)
- [claw-autopilot](./technical-design/modules/claw-autopilot/README.md)
- [pricing-risk-policy](./technical-design/modules/pricing-risk-policy/README.md)
- [settlement-payout](./technical-design/modules/settlement-payout/README.md)
- [cli](./technical-design/modules/cli/README.md)
- [rbob-ledger](./technical-design/modules/rbob-ledger/README.md)

## Naming Convention

- top-level design categories use kebab-case nouns: `product-design`, `technical-design`, `design-governance`
- each directory entry file is `README.md` (or `README.zh.md`)
- paired bilingual documents use `.md` and `.zh.md` with identical base names

## Language

- English entry: `README.md`
- Chinese entry: `README.zh.md`

Every documentation directory follows the same convention.
