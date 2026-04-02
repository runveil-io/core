# Overview

## Purpose

This section defines what Veil is, what it is trying to optimize for, and what it explicitly does not try to be.

## Read This Section If

- you are new to the project
- you need the shortest product-level explanation of Veil
- you want the intended scope before reading architecture or code

## What Veil Is

Veil is being built as an open-source AI capacity marketplace. Its current runtime is an AI inference routing system that gives callers a local, OpenAI-compatible gateway and routes encrypted requests to available Providers through Relay nodes so AI access can be consumed through Veil instead of being bound one-to-one to a specific upstream account in every client.

## Long-Term Product Goal

Veil is being built toward an agent-operated AI capacity marketplace. In the target experience, an operator tells Claw to join the network and start selling available inference capacity, and the runtime handles discovery, registration, pricing, routing, witness, and settlement with minimal manual intervention.

This long-term goal is grounded in [Product Vision](../../design-governance/product-vision.md), not added as a separate late-stage idea.

## Core Value

Veil focuses on five things:

- compatibility with existing AI clients
- accountless access to AI through a local gateway and routed network supply
- separation between control-plane visibility and execution visibility
- reusable supply from Providers
- evidence boundaries for budget, witness, and reconciliation
- keeping settlement on the main path without making the runtime chain-first

## Product Direction

- Consumers use one local interface to reach available model supply
- Providers turn spare AI quota or API capacity into routable execution
- Relays broker supply, enforce routing rules, and record witness
- Claw evolves from a developer helper into the automation layer for joining, operating, and monetizing nodes
- crypto-native payment and settlement stay on the product path even when the current runtime still uses quote units and off-chain evidence
- the open-source build loop keeps protocol evolution visible and auditable

## Main Roles

- `Consumer`: runs the local gateway and sends requests
- `Relay`: verifies, routes, limits, and records witness data
- `Provider`: decrypts, executes upstream inference, and returns results
- `Bootstrap`: publishes Relay availability

## Non-Goals

- unqualified anonymity claims
- making the runtime chain-first before the market loop works
- generic compute execution
- upstream policy evasion as a public feature

## Next Reading

- [Product](../../design-governance/README.md)
- [System Model](../../technical-design/system-model/README.md)
- [Architecture](../../technical-design/architecture/README.md)
- [Modules](../../technical-design/modules/README.md)
