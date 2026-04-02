# Vision Traceability Matrix

## Purpose

This matrix maps runtime modules to the five outcomes in [Product Vision](../design-governance/product-vision.md):
`Access`, `Privacy`, `Market`, `Automation`, and `Settlement`.

Use it during design review and documentation updates to prevent drift-by-omission.

## Module Mapping

| Module | Access | Privacy | Market | Automation | Settlement | Rationale |
|---|---|---|---|---|---|---|
| `consumer-gateway` | Yes | Partial | Partial | Partial | Partial | Primary OpenAI-compatible entrypoint; includes budget and routing context. |
| `provider-engine` | Partial | Partial | Yes | Partial | Partial | Realizes sell-side capacity execution and preserves evidence continuity for settlement. |
| `relay` | Partial | Yes | Yes | Partial | Yes | Handles routing, witness, and market mediation with signed usage records. |
| `bootstrap-discovery` | Partial | Partial | Yes | Partial | No | Keeps relay availability and broker selection explicit. |
| `network-transport` | Yes | Partial | Partial | Yes | No | Shared connectivity and reconnect behavior sustain access and low-touch operation. |
| `wallet-identity` | Partial | Yes | No | Partial | No | Maintains keys and identity boundaries required for accountless and privacy-preserving behavior. |
| `metering-witness` | No | Partial | Partial | No | Yes | Produces usage evidence required for payout-capable settlement. |
| `pricing-risk-policy` | No | No | Yes | Yes | Yes | Defines deterministic pricing and risk controls, while preserving quote/settlement separation. |
| `settlement-payout` | No | No | Yes | Partial | Yes | Converts witness-plus-pricing data into auditable payout outputs. |
| `claw-autopilot` | Partial | Partial | Yes | Yes | Partial | Automates onboarding and market operations with policy and health gating. |
| `cli` | Partial | Partial | Partial | Yes | No | Operator surface transitioning manual workflows into supported automation paths. |

## Documentation Surface Mapping

| Documentation Area | Access | Privacy | Market | Automation | Settlement | Rationale |
|---|---|---|---|---|---|---|
| `docs/product-design/overview/` | Yes | Partial | Yes | Partial | Partial | Defines product scope and high-level direction for runtime and market outcomes. |
| `docs/design-governance/` | Yes | Yes | Yes | Yes | Yes | Canonical source for outcomes, principles, and architecture/roadmap constraints. |
| `docs/technical-design/system-model/` | Yes | Yes | Yes | Yes | Yes | Defines role visibility, request path, and operator path including witness and settlement inputs. |
| `docs/technical-design/architecture/` | Yes | Yes | Yes | Yes | Yes | Defines bounded contexts and explicit quote-versus-settlement separation rules. |
| `docs/technical-design/modules/` | Yes | Yes | Yes | Yes | Yes | Module contracts allocate implementation ownership against all five outcomes. |
| `docs/technical-design/protocol/` | Partial | Yes | Yes | Partial | Yes | Wire contracts, market contract notes, and witness evidence chain enforce privacy boundaries and settlement reproducibility. |
| `docs/product-design/trust-and-privacy/` | Partial | Yes | Partial | Partial | Yes | Defines public privacy posture, trust boundaries, and how split visibility complements settlement evidence. |
| `docs/product-design/roadmap/` | Yes | Yes | Yes | Yes | Yes | Staged delivery and execution gates keep all outcomes on the main path. |
| `docs/operations/` | Partial | Partial | Yes | Yes | Yes | Runtime operability, release gates, and economic readiness checks support market and settlement reliability. |
| `docs/technical-design/configuration/` | Partial | Partial | Partial | Partial | Partial | Documents runtime controls and includes guardrails on market role and quote/settlement semantics. |
| `docs/clients/` | Yes | Partial | Yes | Partial | Partial | Access integration surface with explicit market-network context and quote-to-settlement boundary notes. |
| `docs/product-design/governance-and-economics/` | Partial | Partial | Yes | Partial | Yes | Defines market economics and settlement continuity, separate from contribution accounting. |

## Review Rules

- Every module README should explicitly mention at least one outcome it supports.
- Any module that touches pricing, witness, or payouts must preserve quote-versus-settlement separation.
- Relay-facing modules should describe Relay as both control-plane and market role, not only transport infrastructure.
- Automation-facing modules should describe how they reduce manual operator work without bypassing security gates.
