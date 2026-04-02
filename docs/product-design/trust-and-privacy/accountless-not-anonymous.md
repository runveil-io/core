# Accountless, Not Anonymous

## Purpose

This note explains why Veil describes itself as `accountless` and `privacy-preserving`, not as a system that guarantees anonymity.

## Short Answer

Veil reduces direct account coupling and splits visibility across roles. That is valuable, but it is not the same thing as proving that a user is anonymous to every operator, upstream provider, or observer.

This wording correction is not a rollback of Veil's market, automation, or privacy goals. It is a precision fix for the public contract.

## What `Accountless` Means In Veil

- local clients can access Veil through one local gateway instead of embedding separate upstream account flows in every tool
- Relay can broker traffic without becoming the model execution host
- Provider can execute requests without receiving the full local Consumer environment

`Accountless` is about removing per-client upstream account wiring from the normal usage path. It is not a claim that all identity or correlation signals disappear.

## Why Veil Does Not Claim `Anonymous`

Strong anonymity would require Veil to defend against more than prompt disclosure.

- Relay still sees routing and witness metadata
- Provider still sees plaintext execution payloads
- upstream model providers may still observe request timing, model usage, and account-level behavior
- traffic analysis, node collusion, and endpoint compromise are outside the guarantees of the current design

Because of that, public documentation should not describe Veil as guaranteed anonymous, untraceable, or immune to operator correlation.

## Why `Relay Sees Who, Provider Sees What` Was Removed

That phrase is a useful shorthand, but it is too compressed to be a reliable public security statement.

What it gets right:

- Relay does not need prompt plaintext to route requests
- Provider sits inside the execution boundary

What it hides:

- Relay can still observe connection-level and routing-level metadata
- Provider can infer context from payload structure, workload shape, or repeated task behavior
- neither sentence proves anonymity against colluding operators or upstream visibility

The current wording is more precise: Relay sees routing and witness metadata, but not prompt plaintext. Provider sees plaintext execution payload, but should not receive unnecessary Consumer-side local context.

## Why `relay.runveil.io` Was Removed From Canonical Entry Docs

A single hard-coded Relay endpoint can serve as an example, but it should not define the product architecture.

Veil now documents:

- configured Relay endpoints
- Bootstrap-driven Relay discovery
- multi-Relay operation as part of the system direction

Keeping one public hostname in the canonical architecture and contribution docs creates the wrong expectation:

- it makes Veil look like a permanently single-operator system
- it weakens the role of Bootstrap and discovery in the documented architecture
- it turns one deployment detail into a protocol assumption

If Veil runs an official public Relay, that belongs in operations or onboarding examples, or as a documented default entrypoint, not in the core trust model. The goal is to keep a default entrypoint from hardening into a protocol assumption.

## Why `clawd build` Was Removed From Public Docs

`clawd build` was not useless as an internal workflow idea. It was removed from canonical entry docs because it is not part of the repository's supported public interface today.

Public docs should only describe workflows that are:

- available in the repository today
- reproducible by external contributors
- aligned with the documented command surface

The current repo exposes:

- `veil` as the runtime CLI
- `npm test` and related commands for development
- `desired/*.yaml`, failing tests, and TODOs as contribution sources

An undocumented external agent command in canonical docs creates avoidable confusion. What was removed is the unsupported command syntax, not the automation goal itself.

The original product intent still requires Claw to return as a supported automation surface for joining, selling, and operating nodes. That work now lives in the documented `Claw Autopilot` product and roadmap path.

## Public Language Rule

Use:

- accountless access
- privacy-preserving routing
- split visibility across roles

Avoid:

- anonymous by default
- no identity
- no tracking
- impossible to correlate

## Next Reading

- [Trust and Privacy](./README.md)
- [System Model](../../technical-design/system-model/README.md)
- [Protocol](../../technical-design/protocol/README.md)
