# Protocol

## Purpose

This section describes the wire-level contract between Veil runtime roles.

## Read This Section If

- you are implementing Consumer, Relay, or Provider message handling
- you are reviewing signatures, envelopes, or message types
- you need the request and response contract before changing code

## Transport

- WebSocket between Consumer, Relay, and Provider
- HTTP for Bootstrap APIs
- JSON message payloads

## Top-Level Message

```ts
interface WsMessage {
  type: MessageType;
  request_id?: string;
  payload?: unknown;
  timestamp: number;
}
```

## Main Message Types

- `provider_hello`
- `provider_ack`
- `request`
- `response`
- `stream_start`
- `stream_chunk`
- `stream_end`
- `error`
- `ping`
- `pong`
- `list_providers`
- `provider_list`

## Request Envelope

Consumer requests contain:

- `outer`: metadata visible to Relay
- `inner`: base64-encoded sealed bytes intended for the Provider

`outer` carries:

- Consumer public key
- Provider id
- model
- pricing version or offer reference when deterministic settlement is required
- signature

`inner` carries:

- messages
- model parameters
- stream flag

## Signing

The Consumer signs:

- request id
- consumer public key
- provider id
- model
- timestamp
- inner payload hash

Relay verifies the signature before forwarding.

## Sealed Payload

The sealed request format is:

```text
[sender_public_key(32)] [nonce(24)] [ciphertext(...)]
```

Relay forwards the sealed payload without decrypting it.

## Response Path

- non-streaming responses return `encrypted_body`
- streaming responses emit `stream_start`, `stream_chunk`, and `stream_end`
- `stream_end` carries usage and completion metadata needed for witness generation

## Directory Messages

Relay publishes Provider availability through:

- `list_providers`
- `provider_list`

## Market Contract Notes

- `provider_list` makes sell-side supply and broker visibility explicit instead of implicit infrastructure behavior.
- pricing version or offer references in request metadata bind routing-time quotes to reproducible settlement evidence.
- witness records plus `dedupe_key` provide auditable market outcomes while preventing replayed accounting.

For the Relay market-role boundary, see [Relay Module](../modules/relay/README.md).

## Error Semantics

Errors are returned as:

```ts
interface ErrorPayload {
  code: string;
  message: string;
}
```

## Witness Semantics

Relay records a signed witness when a request completes. The witness must be joinable with a deterministic pricing snapshot so settlement can be reproduced later.

## Settlement Evidence Chain

```ts
interface WitnessRecord {
  request_id: string;
  provider_id: string;
  relay_id: string;
  model: string;
  usage: NormalizedUsage;
  pricing_version: string;
  quote_unit: 'usd_estimate';
  completion_status: 'success' | 'error' | 'aborted';
  completed_at: number;
  evidence_hash: string;
  dedupe_key: string;
  provider_usage_hash?: string;
  relay_signature: string;
}
```

- `pricing_version` binds the witness to deterministic quote terms
- `quote_unit` expresses budgeting and comparison language, not the final settlement asset
- `evidence_hash` and `dedupe_key` let settlement systems reject replayed or double-counted records
- `provider_usage_hash` is optional when upstream usage receipts can be hashed into the evidence chain
