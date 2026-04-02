# Documentation Governance Rules

## Purpose

This document defines how Veil documentation is classified, named, reviewed, and maintained so product and technical docs stay aligned over time.

## Canonical Taxonomy

### `docs/product-design/`

Use for product-facing intent and direction:

- product scope and positioning
- trust and privacy posture
- governance and economics boundaries
- roadmap sequencing

Do not place protocol internals, config key references, or module contracts here.

### `docs/technical-design/`

Use for implementation-facing system design:

- system model and runtime responsibilities
- architecture planes and bounded contexts
- module contracts
- protocol contracts
- runtime configuration surfaces

Do not place product narrative or roadmap policy rationale here.

### `docs/design-governance/`

Use for cross-cutting design alignment and guardrails:

- product vision
- traceability matrix
- documentation governance rules

Do not place tutorials, runbooks, or endpoint usage examples here.

### `docs/clients/`, `docs/installation/`, `docs/manual/`, `docs/operations/`, `docs/glossary/`

These remain functional domains for integration, setup, operation, and terminology.

## Naming Rules

- directory and file names use kebab-case
- every directory must have `README.md` and `README.zh.md`
- bilingual document pairs must share the same basename:
  - `name.md`
  - `name.zh.md`
- avoid ambiguous names such as `notes.md`, `misc.md`, `draft-v2.md`

## Document Structure Rules

Each section README should include:

- purpose
- what belongs here
- what does not belong here
- next reading links

Normative docs (vision, matrix, governance rules) should also include review usage guidance.

## Cross-Link Rules

- each doc should link upward to its section index
- each doc should link sideways to at least one related neighboring section
- product-design docs should link to at least one governance anchor
- technical-design docs should link to at least one product or governance rationale

## Change Management Rules

When adding or moving docs:

1. include placement rationale in PR description
2. update parent `README` navigation
3. keep EN/ZH parity for affected files
4. run broken-link search before merge

When deprecating docs:

- keep a redirect stub for one review cycle when practical
- then delete after references are fully updated

## Review Checklist

- does this document belong to the selected folder by purpose?
- is naming compliant and bilingual pairing complete?
- are links updated in section and root indexes?
- does wording stay consistent with Product Vision and traceability rules?
- does this change create overlap with an existing canonical doc?

## Quick Placement Decision Tree

- first-time setup -> `docs/installation/`
- role-based usage workflow -> `docs/manual/`
- runtime operability and release readiness -> `docs/operations/`
- client integration examples -> `docs/clients/`
- product intent, trust posture, economics, roadmap -> `docs/product-design/`
- architecture, modules, protocol, config -> `docs/technical-design/`
- cross-cutting alignment constraints and traceability -> `docs/design-governance/`
- canonical term definitions -> `docs/glossary/`
