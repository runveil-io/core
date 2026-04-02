# Roadmap

## Purpose

This section describes the staged delivery order for Veil. It is a forward-looking implementation sequence.

Everything in this section is roadmap scope unless another section explicitly marks it as already implemented.

## Planning Rule

Each phase should leave the system more operable and more verifiable than before. New capability should not outrun protocol clarity, security boundaries, or runtime visibility.

Use [Execution Rules](./execution-rules.md) as the hard dependency and phase-gate reference when turning this roadmap into implementation tasks.
Use [Product Vision](../../design-governance/product-vision.md) as the product constraint source when deciding what must remain on the main path.

## North Star

The target Veil operator experience is:

1. tell Claw to join the network
2. tell Claw to start selling available inference capacity
3. let the system keep the node online, priced, routed, witnessed, and recoverable with minimal manual intervention

## Planning Tracks

- `Autopilot`: remove manual node lifecycle work
- `Marketplace`: turn capacity into sellable network supply
- `Settlement`: move from witness records and quote units to payout-capable, crypto-compatible accounting
- `Privacy`: keep accountless, privacy-preserving routing while the market loop grows

## Phase 1: Reliable Runtime Baseline

- stabilize the local Consumer gateway as the default accountless entry point
- stabilize Relay to Provider request forwarding
- keep witness, budget, and error flows usable for real Consumer to Provider paths

## Phase 2: Discovery And Multi-Relay Reachability

- mature Bootstrap and Relay discovery
- support better Relay selection
- improve multi-Relay Provider reachability
- make available Provider supply easier for Consumers to discover and use

## Phase 3: Guided Operator Automation

- harden runtime limits and connection behavior
- strengthen Relay and Provider health management
- tighten secret handling and operator workflows
- make running a Provider safer and more predictable as an economic role
- add the first Claw-managed join and startup flow so operators no longer need to hand-assemble every runtime step

## Phase 4: Autonomous Marketplace Control

- improve replay protection and request contracts
- strengthen usage and witness evidence
- improve protocol versioning and compatibility
- introduce policy-driven capacity publication and pricing controls
- let Claw keep sell-side policy, health, and recovery aligned without constant operator intervention

## Phase 5: Witness-Backed Settlement

- keep governance and inference accounting aligned but separate
- mature contribution accounting and export flows
- make pricing and witness-backed settlement interfaces usable
- separate quote units used for budgeting from settlement assets used for payment rails
- prepare cleaner interfaces for payment rails and Provider or Relay payout systems
- keep crypto-native settlement on the main path instead of treating it as an optional add-on
- align the product market loop and the open-source build loop without collapsing them into one ledger

## Phase 6: Low-Touch Market Operation

- let Claw operate Provider nodes in a near-autonomous mode
- automate repricing, pause and resume behavior, and sell-side risk envelopes
- reduce manual configuration to operator intent, policy guardrails, and credential approval

## Phase 7: Optional Advanced Privacy Profile

- explore a stronger privacy profile only after the marketplace loop works operationally
- separate the standard marketplace profile from any future anonymity-heavy profile
- avoid letting anonymity claims outrun the guarantees of the deployed system
