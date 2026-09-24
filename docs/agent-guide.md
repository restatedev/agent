# Guide for coding agents

This file is the handoff contract for Codex, Claude Code, and other coding
agents working in this repository.

Unless a path starts at the repository root, runtime source paths in this
guide are relative to `packages/libs/core`.

## Before changing anything

1. Read [the documentation index](README.md).
2. Inspect `git status` and recent commits. Preserve unrelated and untracked
   user work. Credential files must never be staged or printed.
3. Read the current source for the subsystem. Do not rely only on summaries or
   an earlier conversation: this repository evolves quickly.
4. Read the relevant guide:
   - controller or transcript: [architecture](architecture.md) and
     [protocol](protocol.md);
   - turn behavior: [turn runtime](turn-runtime.md);
   - built-in, discovered Restate, or MCP tools:
     [tools](tools.md);
   - sandbox lifecycle: [sandboxes](sandboxes.md);
   - validation: [development](development.md).
5. State the behavior you intend to preserve before refactoring control flow.

## Source-of-truth order

Use executable contracts before prose:

1. Public Zod schemas in `packages/libs/types/src/index.ts`, shared Restate
   descriptors in `packages/libs/types/src/services.ts`, schemas adjacent to
   internal handlers, and `src/model/provider.ts`;
2. handler code in `src/agent/*.ts` (grouped by concern) and
   `src/session/service.ts`;
3. focused ownership modules;
4. docs.

When behavior changes, update all affected layers. A docs-only description of
an unimplemented behavior is a bug.

## Non-negotiable invariants

Preserve these unless the requested change explicitly replaces them:

1. `Agent` is the responsive controller for one `agentId`. It owns active work,
   pending input, profile/memories, approvals, schedules, metadata, child
   bookkeeping and the notification watermarks. AgentSession owns history. No
   account or browser-session service exists.
   Ingress and the optional local UI are trusted operator surfaces.

2. `AgentSession`, keyed by the same `agentId`, owns the canonical transcript
   and summary checkpoint. The transcript is append-only; never rewrite an
   existing user entry to explain later routing.
3. At most one `AgentSession.doTurn` invocation is active for an Agent. Its
   Restate invocation ID is the stable `turnId` and signal target.
4. A turn receives a stable Agent profile including its local memory snapshot. Instructions, memories,
   guardrails, and tool grants changed during that turn affect the next turn.
   The session loads its conversation context once at the beginning of
   `doTurn`.
5. Steering does not cancel the current model/tool step or existing pending
   operations. It is consumed after the current step settles.
6. Interruption ends the turn gracefully: stop and join unfinished work,
   retain completed results, and perform one tool-free finalization call.
7. External invocation cancellation suspends the sandbox and reconciles Agent,
   then rethrows `CancelledError`; it does not pretend to be a graceful model
   finalization.
8. Foreground tools in one model response are spawned together and joined.
9. Pending tools are owned by `doTurn` across steps, keyed by stable tool-call ID,
   and selectively cancellable without stopping unrelated operations.
10. A guardrail gates the exact proposed text or whole tool batch before it is
    published or started. The main agent model does not receive the policy
    list.
11. Tool-call assistant messages and matching tool-result messages remain
    protocol-complete in active-turn model context.
12. Raw reasoning, tool arguments, and tool results do not enter the canonical
    transcript. Concise activity and structured call names/statuses may.
13. Conversation compaction is a derived view. It neither deletes nor mutates
    canonical history.
14. Built-in tools execute inside `AgentSession.doTurn`; do not turn them into service RPCs
    merely to make them durable. Use Restate operations and `restate.run`
    inside the handler.
15. The sandbox's files persist across turns; its compute does not. A turn
    acquires it lazily on first use and always suspends it at its terminal
    boundary. The ref lives in AgentSession state; there is no sandbox service.
16. A discovered Restate handler is a foreground dynamic tool. The catalog
    snapshot used for model inference is the same snapshot used for execution.
17. A configured MCP endpoint contributes foreground tools through its
    explicitly selected stateless `2026-07-28` or stateful 2025-era protocol.
    The exact server, protocol verdict, remote name, and tool definition used
    for inference are retained in the turn snapshot used for invocation.
    MCP credentials resolve from operator environment references inside HTTP
    effects only. Tokens must not cross durable inputs, state, signals, or
    returned credential values. Sanitize provider exceptions before recording
    results. See [MCP configuration](mcp-configuration.md).

18. Keep the layers distinct in prose and code comments: `Agent` is the
    deterministic controller, `AgentSession` owns session history and turn
    execution, one `doTurn` invocation is an agent run, `agentStep` is one loop
    iteration, and the model plus harness/runtime is the operational agent.
19. Notifications carry invalidation only. AgentSession stays authoritative for
    history and Agent for profile, approvals, children and schedules.
20. A schedule's delayed `Agent.fire` routes to the same agent with an explicit
    queue/steer/interrupt policy. It never waits for the whole turn.
21. Child agents inherit a creation-time copy of context and narrower access.
    Parent controllers coordinate exact child turns, but their sessions own
    child-result waits. Children cannot nest or create schedules.

The detailed turn-runtime list lives in
[turn-runtime.md#refactoring-constraints](turn-runtime.md#refactoring-constraints).

## Common traps

- `ask` does not classify intent. It starts while idle and queues while busy.
  The caller explicitly chooses `steer` or `interrupt`.
- `steer` accepts a JSON string at ingress, not `{message: ...}`.
- A void-input ingress handler must receive no body and no `content-type`.
- Restate signal resolutions with the same name form the durable sequence used
  by steering. The in-memory steering inbox is only a turn-local consumer.
- Busy `ask` messages live in Agent pending state until a steer consumes them
  or a successor `doTurn` starts. Only then does AgentSession append them to
  history, preserving FIFO order.
- An interruption reason is control input for the old turn. An optional
  replacement `message` is a separate queued user request for a new turn.
- A candidate text response is not terminal while pending operations exist.
- Guardrail approval and the `humanApproval` tool are related but distinct:
  the former gates an exact runtime proposal before it runs; the latter is an
  explicit model-selected pending tool.
- Resolved approval events are model-relevant. Approval-request and
  cancellation events are derived client status and are not model context.
- Process-local caches (`session/dynamic-tools.ts`, `session/mcp-tools.ts`,
  provider clients) are
  optimizations, never durable sources of truth.
- A sandbox reference carries its provider. Changing `SANDBOX_PROVIDER` does
  not migrate an already-provisioned Agent sandbox.
- The local sandbox is not a security boundary. The Modal adapter is remote
  isolated compute, but its persistent Volume is still Agent-owned data.
- Dynamic handler annotations are a trusted cluster capability boundary:
  documentation enters the model prompt and the handler can be invoked with
  the agent service's authority.
- MCP endpoint configuration is also a trusted capability boundary. Tool
  descriptions and schemas enter the model prompt, credentials resolve inside HTTP effects from operator environment references, and HTTP calls may be repeated
  unless the remote server honors the stable idempotency key.
- AgentSession history is the public conversation event log, not the complete
  agent trajectory or Restate execution trace.
- History is not the invalidation mechanism for every current-state area.
  Drain `AgentSession.history`, then use Agent's notification versions to decide
  whether to re-read history, profile, approvals,
  or schedules.
- `activity` and `progress` are status communication, not chain-of-thought or
  model reasoning.
- The per-Agent `memories` collection is persistent semantic memory for one conversation.
  Active-turn messages are working context, and conversation history is a separate
  canonical log.

## Where a change belongs

| Change | Primary owner |
| --- | --- |
| User message routing and turn start/end | `agent/turns.ts` |
| Authorization checks shared by Agent handlers | `agent/guards.ts` |
| Agent creation and retirement | `agent/lifecycle.ts` |
| Active turn ID, pending user queue, signal delivery/reconciliation | `agent/active-turn.ts` |
| History chunks, cursor, writer, summary checkpoint | `session/history.ts` |
| Notification revisions, subscriptions, and awakeables | `agent/notifications.ts` |
| Instructions, guardrails, tool grants, memories | `agent/profile.ts` |
| Pending approval state and decision signal | `agent/approvals.ts` |
| Children, delegated tasks, inherited profile | `agent/sub-agents.ts` |
| Durable scheduled-message state and timers | `agent/schedules.ts` |
| Cross-step loop, transcript append, step bound, and finalization | `session/service.ts` |
| One model/guardrail/foreground-tool transition | `session/step.ts` |
| Steering signal receiver and transient FIFO | `session/steering.ts` |
| Pending tool tasks and cancellation races | `session/pending.ts` |
| Built-in tool schema, execution, result projection | `session/tools.ts` |
| Transcript-to-model projection | `session/context.ts` |
| Dynamic Restate tool discovery | `session/dynamic-tools.ts` |
| MCP tool discovery and invocation | `session/mcp-tools.ts` |
| AI SDK provider behavior and model contracts | `model/provider.ts` |
| Journaled model calls, retries, output recovery | `model/inference.ts` |
| Turn-owned sandbox lifecycle | `sandbox/turn.ts` |
| Provider contract and provider selection | `sandbox/provider.ts` |
| Local filesystem demo adapter | `sandbox/local-provider.ts` |
| Modal-specific compute/storage | `sandbox/modal-provider.ts` |
| External HTTP consumption | `packages/libs/client/src/index.ts` |

If a proposed change spans several rows, keep each responsibility in its owner.
Avoid a generic abstraction unless two concrete implementations need the same
contract.

## How to add capability safely

### Built-in tool

Read [tools.md](tools.md). Keep name, description, Zod schema, execution, and
pending completion together in `session/tools.ts`. Add it to `definitions`,
preserve cancellation errors, and add a focused test when behavior affects the
Agent protocol.

### Dynamic Restate tool

Do not link it into this package. Annotate its deployed handler with
`restate.dev/agent`, provide accurate handler documentation and JSON schemas,
and ensure JSON-compatible serialization. Read the security and collision rules
in [tools.md](tools.md).

### MCP tool

Configure the endpoint in the core process's `MCP_SERVERS_JSON` and optionally
narrow its Agent grants. Select `stateless` for handshake-free `2026-07-28`
servers and `stateful` for supported 2025-era handshake servers. Do not accept
URLs or credential values from conversation input. Pass only a `tokenEnv`
reference through durable configuration and resolve the token inside the HTTP
effect. Read [MCP configuration](mcp-configuration.md) and [tools](tools.md).

### New Agent handler

Define input and output Zod schemas, decide whether it is a supported client
handler or internal coordination path, choose exclusive versus shared state
semantics, update `packages/libs/client/src/index.ts` if external, document its
state and transcript effects, and add protocol coverage.

### New transcript event

Update `ConversationEventSchema`, then make an explicit exhaustive decision in
`isDerivedConversationEvent`. Update `session/context.ts`,
`model/compactor.ts`, external consumers, protocol docs, and test
assertions as applicable. Never let different consumers silently invent their
own relevance policy.

### New sandbox provider

Implement `SandboxProvider` without moving lifecycle into the adapter;
`sandbox/turn.ts` decides when to provision, resume, suspend and destroy.
Provider calls and client methods are external effects and must run under
`restate.run` with bounded, idempotent behavior. Read [sandboxes.md](sandboxes.md).

## Validation expected after changes

Run checks proportional to the change, normally:

```sh
pnpm lint
pnpm build
pnpm --filter @restate-agents/core test:ptc
pnpm --filter @restate-agents/web test
pnpm bundle
git diff --check
```

Review the final diff for:

- redundant exported types or concepts;
- state or effects in the wrong owner;
- accidental transcript rewrites;
- an unjoined spawned task;
- cancellation swallowed as an ordinary failure;
- schemas that no longer match callers;
- stale docs; and
- staged secrets, local state, or unrelated files.
