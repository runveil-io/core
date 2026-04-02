# Trust and Privacy

## Purpose

This section defines what Veil does and does not promise around privacy, identity, and operator visibility.

## Read This Section If

- you need the public privacy positioning of Veil
- you want to understand the trust split across Consumer, Relay, and Provider
- you need a precise statement that avoids overclaiming anonymity

## Core Position

Veil is designed for accountless access and privacy-preserving routing. It is not designed to promise perfect anonymity.

The main design idea is role separation:

- the Consumer side owns local identity, local prompts, and local policy
- the Relay side owns routing, admission, and witness
- the Provider side owns plaintext execution

## What Veil Protects

- Relay does not need prompt plaintext to route requests
- Providers do not need full Consumer-side local context to execute requests
- local clients can integrate through one gateway instead of embedding many upstream account flows
- witness and accounting records can be kept separate from prompt content

## What Veil Does Not Promise

- perfect anonymity against traffic analysis
- perfect anonymity against colluding Relay and Provider operators
- invisibility from upstream model providers
- protection from a compromised Consumer or Provider endpoint

## Trust Boundaries

| Role | Main Trust Assumption |
|------|------------------------|
| Consumer | local machine and wallet remain under user control |
| Relay | routes and records witness without decrypting business payloads |
| Provider | executes plaintext requests but should not receive unnecessary Consumer context |
| Bootstrap | handles Relay metadata only |

## Public Language Rule

Public documentation should describe Veil as:

- accountless access
- privacy-preserving routing
- split visibility across roles

Public documentation should avoid describing Veil as:

- guaranteed anonymous
- untraceable
- immune to operator correlation

For a more explicit explanation of the wording change, read [Accountless, Not Anonymous](./accountless-not-anonymous.md).

## Privacy Boundaries And Settlement Evidence

Split visibility and settlement evidence are complementary:

- Relay can record signed witness metadata without decrypting prompt plaintext.
- settlement replay depends on witness and pricing evidence, not on expanding role visibility.
- inference records and governance records remain separate ledgers to preserve both privacy boundaries and auditability.

## Next Reading

- [Accountless, Not Anonymous](./accountless-not-anonymous.md)
- [System Model](../../technical-design/system-model/README.md)
- [Protocol](../../technical-design/protocol/README.md)
- [Governance and Economics](../governance-and-economics/README.md)
