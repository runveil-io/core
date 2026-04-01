# Implementation for: Heartbeat Probe — Detect Dead Providers During Task Execution

## Issue
https://github.com/runveil-io/core/issues/25

## Solution
Relay sends probe messages to detect if a Provider is still alive during long-running tasks.

**Design doc:** `docs/design/14-task-lifecycle.md` (Sections 4.1-4.5)

**New wire protocol messages:**
- `probe`: Relay → Provider (request_id, timestamp)
- `probe_ack`: Provider → Relay (status: alive|busy|rate_limited, progress?)

**Implementation:**
- Relay: track `last_activity` per active request. After 30s silence, send probe.
- Provider: respond to probe with current status
- Relay: 2 consecutive
