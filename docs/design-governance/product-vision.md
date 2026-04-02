# Product Vision

## Purpose

This document defines Veil's product vision and uses it as a shared direction for future architecture and roadmap planning.
Its job is to keep architecture and roadmap work aligned with Veil's market, privacy, and automation goals as the system evolves.

## Vision

Veil is an agent-operated AI capacity marketplace network.  
It gives Consumers low-friction, accountless AI access, enables Providers and Relays to participate in durable supply-side economics, and builds long-term system capabilities that balance privacy protection with settlement readiness.

## Core Outcomes

- `Access`: provide local OpenAI-compatible access as the default integration surface
- `Privacy`: reduce identity and request visibility coupling through privacy-preserving routing
- `Market`: make Provider and Relay supply, brokerage, and earnings real operational flows
- `Automation`: use agent automation across onboarding, publishing, operations, and recovery
- `Settlement`: keep witness and pricing data ready for payout-capable settlement paths

## Product Principles

- **Market-first**: Veil is not only transport; it is a supply-and-demand market network
- **Low-friction by default**: user and operator setup should be simpler than direct upstream API wiring
- **Privacy by design**: privacy is a product property, not an optional add-on
- **Automation by design**: agent workflows are part of the product surface, not only internal tooling
- **Settlement continuity**: payment and settlement can be staged, but must stay on the mainline direction

## Architecture Constraints

Any future architecture should preserve these constraints:

1. local OpenAI-compatible access remains the default integration surface
2. Provider capacity publication must become a real sell-side workflow, not just a background concept
3. Relay stays a visible market role with routing and witness responsibilities
4. witness and pricing must be able to feed settlement later
5. Claw or an equivalent automation layer must become part of node onboarding and operation
6. privacy language may be tightened, but the architecture should still optimize for split visibility and lower identity coupling

## Roadmap Constraints

The roadmap should therefore preserve five parallel outcomes:

- `Access`: keep the local gateway and client compatibility strong
- `Privacy`: keep privacy-preserving routing and lower identity coupling on the main path
- `Market`: make Provider and Relay roles economically real
- `Automation`: reduce manual join, publish, and recovery work
- `Settlement`: turn witness-backed accounting into payout-capable flows

If a roadmap iteration improves runtime polish but weakens these outcomes, it should be treated as a drift from the product vision.

## Use This Document When

- reviewing roadmap changes
- introducing a new core module
- simplifying architecture in ways that might remove market or automation goals
- deciding whether a feature belongs in the product core or only in tooling

## Next Reading

- [Product](./README.md)
- [Roadmap](../product-design/roadmap/README.md)
- [Execution Rules](../product-design/roadmap/execution-rules.md)
