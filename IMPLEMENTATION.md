# Implementation for: WebSocket Reconnect Improvements

## Issue
https://github.com/runveil-io/core/issues/8

## Solution
`network/index.ts` has basic reconnect with `WS_RECONNECT_BASE_MS`/`WS_RECONNECT_MAX_MS` but needs: exponential backoff with jitter, max attempts, state machine with typed events.

**Acceptance Criteria:**
- Backoff: base 1s, 2x multiplier, max 30s, random jitter 0-1s
- State machine: connecting → connected → disconnecting → disconnected → reconnecting
- Max attempts configurable (default 10), emit `failed` event after
- Tests: backoff timing, state transitions, max attempts, jitter bounded

**E
