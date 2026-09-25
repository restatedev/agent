# Documentation

This is a local reference implementation of durable agent execution. The core
request path begins with an agent ID, without an account or login prerequisite.

## Reading path

1. [Run a conversation](../README.md).
2. [Architecture](architecture.md): controller, turn, state owners, notifications.
3. [Protocol](protocol.md): ask, steer, interrupt, history, approvals and clients.
4. [Turn runtime](turn-runtime.md): steps, policy, background work and recovery.
5. [Tools](tools.md): built-ins, PTC, dynamic Restate handlers and MCP.
6. [MCP configuration](mcp-configuration.md): operator endpoints and environment credentials.
7. [Schedules](schedules.md) and [sandboxes](sandboxes.md): durable timer and resource lifecycles.
8. [Development](development.md): verification and debugging.

[PROJECT.md](../PROJECT.md) maps the source tree. Coding agents should read
[agent-guide.md](agent-guide.md) before changing runtime semantics.

## Source of truth

Use wire schemas in `packages/libs/types/src/index.ts` and service contracts in
`services.ts` for exact shapes. Use runtime code and focused tests for behavior.
Update this documentation alongside behavior changes; historical review notes
are not current configuration instructions.
