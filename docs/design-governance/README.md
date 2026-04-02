# Design Governance

## Purpose

This section defines the governance baseline for product and technical design alignment.

The canonical constraint source is [Product Vision](./product-vision.md).

## Read This Section If

- you want the user-facing and operator-facing thesis behind Veil
- you need to understand why Consumers, Providers, and Relays all exist
- you want the product loop before reading implementation details

## Product Thesis

Veil turns AI access into a routable network path:

- Consumers use one local OpenAI-compatible gateway
- Providers contribute spare AI capacity or API quota
- Relays broker traffic and witness without becoming the execution endpoint

The product goal is to reduce the coupling between a user's tools and a single upstream account while still keeping execution auditable.

## Intent Anchor

The original public Veil promise was broader than the current runtime boundary. That original intent still constrains planning:

- Veil is meant to be a market, not only a routing layer
- Claw is meant to become part of the product surface, not stay outside it
- settlement and sell-side economics are core outcomes, not optional additions

Read [Product Vision](./product-vision.md) before weakening any of these threads.

## North Star Experience

The end-state Veil experience minimizes manual node operation. An operator should be able to tell Claw to join the network and start selling available capacity, while Veil handles the operational path:

- bootstrap or discover reachable Relay infrastructure
- register Provider capabilities and capacity
- apply pricing and risk policy
- accept and execute routable demand
- record witness and drive settlement
- pause, recover, or reprice automatically when conditions change

## Core User Roles

- `Consumer`: wants usable AI access through a local interface
- `Provider`: wants to expose spare capacity as routable supply
- `Relay`: wants to operate routing and witness infrastructure
- `Claw`: wants to automate node onboarding, operations, pricing, and recovery on behalf of the operator
- `Contributor`: wants to improve the protocol and tooling through open-source work

## Product Promises

- OpenAI-compatible local access
- accountless access through the Veil path instead of direct per-client upstream integration
- reusable Provider-side supply
- privacy-preserving role separation
- witness-backed accounting boundaries
- a roadmap toward low-touch node operation and automated selling of routable capacity

## Main Scenarios

- a user wants AI access from existing tools without wiring every tool to a dedicated upstream account
- a Provider wants to turn spare quota or capacity into usable network supply
- a Relay operator wants to broker traffic without needing prompt plaintext
- an operator wants Claw to join the network, publish capacity, and keep a Provider node selling with minimal manual work
- a contributor wants to improve the system and retain an auditable contribution trail

## Value Flow

```text
Consumer demand -> Relay routing -> Provider execution -> Witness -> Pricing / Settlement
                               \-> Open-source contributions -> RBOB accounting
```

Pricing and settlement are product-direction interfaces. The current runtime already exposes witness and accounting boundaries, but it does not yet expose full payment rails or payout interfaces.

## Current Boundary vs Target Boundary

- current runtime: explicit CLI-driven startup, manual configuration, static Relay defaults, and operator-managed Provider lifecycle
- target runtime: Claw-managed join flow, automatic relay discovery, policy-driven pricing, automated capacity publishing, and witness-backed settlement workflows

## Product Red Lines

- Veil should not require custom client protocols for normal use
- Veil should not make unqualified anonymity claims
- Veil should not expose upstream policy evasion as a public product feature
- Veil should not mix inference witness and contributor accounting into one data path

## Next Reading

- [Product Vision](./product-vision.md)
- [Documentation Governance Rules](./documentation-governance-rules.md)
- [System Model](../technical-design/system-model/README.md)
- [Trust and Privacy](../product-design/trust-and-privacy/README.md)
- [Governance and Economics](../product-design/governance-and-economics/README.md)
