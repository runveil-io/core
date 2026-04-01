# Implementation for: Provider Multi-Account Pool — Rotate API Keys Across Accounts

## Issue
https://github.com/runveil-io/core/issues/42

## Solution
## Context
From design doc `06-provider-engine.md`: Providers may have multiple API keys/accounts. Currently only one key is used.

## Task
Implement `src/provider/accounts.ts`:

1. Load multiple API keys from `provider.json` (`apiKeys` array)
2. Round-robin selection for each new request
3. Track per-key rate limit state (429 → cooldown that key, try next)
4. Expose `getNextKey(): { provider, key, index }`
5. Key health dashboard: `GET /provider/keys` (status per key, no secrets exposed)

## Ac
