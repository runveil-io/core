# Architecture

## Purpose

This section explains the runtime topology of Veil and the ownership boundaries between major runtime planes.

Architecture simplification should be checked against [Product Vision](../../design-governance/product-vision.md) so the project does not simplify away its market, settlement, or automation goals.
For a module-to-vision mapping, see [traceability-matrix.md](../../design-governance/traceability-matrix.md).

## Read This Section If

- you need to map a feature to the right runtime boundary
- you are reviewing trust, persistence, or ownership decisions
- you want the shortest path from product behavior to implementation structure

## Runtime Topology

The current runtime already implements Consumer Gateway, Relay, Provider, Bootstrap, Wallet, and RBOB. Claw Autopilot is the documented automation layer for the target operating model.

- `Consumer Gateway`: local OpenAI-compatible access layer
- `Relay`: routing and witness broker
- `Provider`: upstream execution node
- `Bootstrap`: Relay discovery service
- `Claw Autopilot`: node onboarding and operational automation layer
- `Wallet`: local key and secret store
- `RBOB Ledger`: contribution accounting store

## Bounded Contexts

### Access Plane

Owned by Consumer Gateway. Handles client compatibility, request packaging, response formatting, and budget controls.

### Control Plane

Owned by Relay and Bootstrap. Handles discovery, admission, routing, limits, and witness recording.

### Autopilot Plane

Owned by Claw. Handles node join flows, runtime orchestration, policy application, failure recovery, and low-touch operator automation.

### Execution Plane

Owned by Provider. Handles decryption, upstream requests, and local account governance.

### Market Plane

Owned jointly by Provider policy, Relay admission, and `pricing-risk-policy`. Handles capacity publication, price strategy, quote semantics, settlement-asset hints, and sell-side operating limits.

### Identity Plane

Owned by Wallet and local config. Handles key material and encrypted credentials.

### Governance Plane

Owned by the RBOB ledger and review process. Handles contribution accounting separately from inference traffic.

### Settlement Plane

Owned by witness records, pricing interfaces, and `settlement-payout`. Handles the transition from usage evidence to billable or payable outcomes without collapsing governance and inference into one ledger.

It must keep quote units separate from final settlement assets so budgeting, pricing, and payment rails do not get conflated.

## Persistent Stores

- `wallet.json`
- `config.json`
- `provider.json`
- `relay.db`
- `witness.db`
- `relay_registry`
- `rbob_ledger`

## Planned Control Additions

- policy state for automated pricing and risk envelopes
- operator intent state managed by Claw
- settlement state derived from witness and pricing records

## Vision Constraint Checklist

- preserve local OpenAI-compatible access as the default integration surface
- keep privacy-preserving routing and lower identity coupling across Consumer, Relay, and Provider boundaries
- preserve Relay as a visible market and witness role
- keep quote units and final settlement assets clearly separated
- keep Claw or equivalent automation on the primary operator path
