# Implementation for: Wire Protocol Version Negotiation

## Issue
https://github.com/runveil-io/core/issues/39

## Solution
## Context
From design doc `11-wire-protocol.md`: version field exists in WsMessage but negotiation is not implemented.

## Task
Add protocol version negotiation during `provider_hello` handshake:

1. Add `protocol_version: string` to `provider_hello` payload
2. Relay checks version compatibility (semver range)
3. `provider_ack` includes `negotiated_version`
4. Reject connections with incompatible versions (clear error message)

## Acceptance Criteria
- `provider_hello` includes version string
-
