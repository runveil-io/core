# CLAUDE.md - AI Assistant Context File

## Project Overview
Bounty fix for: https://github.com/runveil-io/core/issues/48

## Issue Requirements
## Context
Currently `Ctrl+C` kills processes without cleanup. Active streams get broken, WebSocket connections drop without goodbye.

## Task
Add graceful shutdown to all three roles:

1. **Consumer**: drain active streams, send abort to Relay, close HTTP server
2. **Provider**: finish current request (or timeout 30s), disconnect from Relay
3. **Relay**: notify connected Providers/Consumers, close all WebSocket connections, flush witness DB
4. Handle SIGINT + SIGTERM
5. CLI shows "Shutting down..." with spinner, "Done" when clean

## Acceptance Criteria
- Active streams complete or timeout (30s max)
- WebSocket connections closed with proper close frame (1001)
- SQLite DBs flushed (WAL checkpoint)
- No zombie processes
- Tests: shutdown during active stream, shutdown with no activity

## 

## Implementation
This template addresses the bounty requirements with a comprehensive, opinionated guide.

## Stack
- Node.js 20+, Next.js 15, SQLite, Drizzle ORM

## Conventions
- Named exports, Server Components by default
- Drizzle for DB, Zod for validation

## Anti-Patterns
- NO \ny\, NO inline styles, NO class components
