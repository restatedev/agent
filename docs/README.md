# Restate agent reference: documentation

This directory is the technical guide to the project. It is written for both
engineers and coding agents that need an explicit map of ownership, contracts,
and invariants before changing the runtime.

If you are pointing Codex, Claude Code, or another coding agent at the
repository, start with:

> Read `docs/agent-guide.md` and `docs/README.md`, then read the guide for the
> subsystem you will change. Confirm the current implementation before editing.

## What this project is

This is a reference implementation of a **durable, single-agent harness and
runtime** on Restate. The model and harness together form the operational
agent. The implementation keeps the important control flow visible:

- dedicated controller, session, notification, scheduler, and sandbox objects
  per `agentId`;
- one `AgentSession.doTurn` invocation per agent run;
- an append-only, cursor-consumable conversation event log;
- model inference behind scoped admission and retry control;
- parallel foreground tool batches and cross-step pending tools;
- programmatic tool calling (PTC): model-written JavaScript coordinates tools
  with replay-safe promise completion and compact results for model context;
- explicit queue, steer, interrupt, and selective-cancellation semantics;
- user instructions, shared user memories, runtime guardrails, and approvals;
- non-destructive conversation compaction;
- scheduler-owned durable messages and an agent-scoped sandbox;
- annotation-driven discovery of Restate handlers and configured stateless or
  stateful MCP tools; and
- a durable black-box evaluation harness.

The seams are durable ownership boundaries, not framework extension points.

## Architecture in three views

Start with the [three diagrams in the root README](../README.md#architecture),
then follow the same boundaries in the architecture guide:

1. [Agent: control the task](architecture.md#agent-virtual-object) — keep
   `AgentSession.doTurn` opaque; start it, track its ID, steer or interrupt it,
   resolve waits, and handle `onTurnEnd`.
2. [AgentSession.doTurn: execute the task](architecture.md#agentsession-virtual-object)
   — load conversation context, run the model/tool loop, apply steering, and
   clean up at the terminal boundary.
3. [Notifications: refresh the client](architecture.md#agentnotifications-virtual-object)
   — publish topic versions, wake readers, and re-read the state owner.

Model providers, tool backends, sandboxes, and schedules are supporting details,
not additional boxes in the Agent controller view.

## The nine Restate services

| Service | Shape | Identity | Responsibility |
| --- | --- | --- | --- |
| `User` | Virtual Object | issuer + subject hash | Identity, agent directory, shared MCP configuration and encrypted authorization |
| `UserSession` | Virtual Object | random session identifier hash | Backing expiry/revocation for five-minute BFF cookie leases |
| `Agent` | Virtual Object | `agentId` | Serialized routing, active invocation, queued input, profile, approvals, and external deliveries |
| `AgentSession` | Virtual Object | same `agentId` | Authoritative transcript, summary checkpoint, and one exclusive `doTurn` agent-run state machine at a time |
| `AgentNotifications` | Virtual Object | same `agentId` | Revision watermarks, caller awakeables, and invalidation long-polls |
| `UserNotifications` | Virtual Object | `userId` | Shared workspace invalidations and one browser long poll across all owned agents |
| `AgentScheduler` | Virtual Object | same `agentId` | Schedule registry, delayed invocations, recurrence, cancellation, and delivery |
| `ModelGateway` | scoped Service | scope `openai` + limit key | Admission control, retries, cancellation propagation, and provider-call boundary |
| `Sandbox` | Virtual Object | same `agentId` | Serialized lifecycle and one-turn lease for the agent's external workspace |
| `Evals` | Service | suite invocation | Concurrent black-box trials against fresh agent instances |

`User`, `UserSession`, `Agent`, `AgentSession`, `AgentNotifications`, `AgentScheduler`, and `Sandbox`
own Virtual Object state.
`ModelGateway` and `Evals` are stateless services. The invocation ID of
`AgentSession.doTurn` is the stable `turnId` and signal target.

See [user identity and ownership](user-identity.md) for Google setup, the BFF security boundary, shared connections, and per-agent grants.

## Documentation map

Read in this order when learning the entire project:

1. [Coding-agent guide](agent-guide.md) — source-of-truth rules, invariants,
   common traps, and change routing.
2. [Architecture and data flow](architecture.md) — service boundaries, state
   ownership, execution sequences, context, and failure behavior.
3. [Agent protocol](protocol.md) — Agent and AgentSession handlers, request and
   response shapes, notifications, and event-log entries.
4. [Turn runtime](turn-runtime.md) — the `doTurn` state machine, steering,
   interruption, guardrails, pending operations, and finalization.
5. [Tools](tools.md) — built-in tools, foreground versus pending behavior,
   dynamic Restate handler discovery, and MCP integration. The
   [PTC guide](tools.md#programmatic-tool-calling-ptc) covers JavaScript tool
   orchestration, the default-on `AGENT_PTC_ENABLED` flag, replay, and subtool
   policy enforcement.
6. [Sandboxes](sandboxes.md) — lifecycle, provider contract, local and Modal
   adapters, and adding another provider.
7. [Development and verification](development.md) — setup, local operation,
   evals, validation, and troubleshooting.
8. [Evals](evals.md) — suite protocol, isolation, current tasks, and gaps.
9. [Credential encryption](credential-encryption.md) — `APP_SECRET_KEY`,
   encrypted MCP state and journals, deployment and key-lifecycle boundaries.

The root [README](../README.md) is the feature overview and runnable demo guide.
[PROJECT.md](../PROJECT.md) is the short source map.

## Canonical source files

Documentation explains the implementation; executable contracts win when they
differ. Use this order:

1. public Zod schemas in
   [`@restate-agents/types`](../packages/libs/types/src/index.ts), service
   descriptors in [`services.ts`](../packages/libs/types/src/services.ts), and
   provider schemas in
   [`gateway/model.ts`](../packages/libs/core/src/gateway/model.ts);
2. handler control flow in
   [`agent/service.ts`](../packages/libs/core/src/agent/service.ts),
   [`session/service.ts`](../packages/libs/core/src/session/service.ts),
   [`notifications/service.ts`](../packages/libs/core/src/notifications/service.ts),
   [`scheduler/service.ts`](../packages/libs/core/src/scheduler/service.ts), and
   [`sandbox/service.ts`](../packages/libs/core/src/sandbox/service.ts);
3. focused component modules under `agent/`, `session/`, `notifications/`,
   `scheduler/`, `gateway/`, and `sandbox/`;
4. these documents.

When behavior changes, update the schema, implementation, relevant eval, and
documentation together.

## The shortest useful mental model

`Agent` decides **when input runs** and owns controller state.
`AgentSession` decides **how the active input is fulfilled** and owns the
conversation log. `AgentSession.doTurn` is one durable agent run; `agentStep`
is one model → guardrail → optional tool-batch iteration. `agentTools` owns tool
schemas and mechanics. `ModelGateway` owns inference admission and retry
behavior. `AgentNotifications` owns invalidation delivery, `AgentScheduler`
owns scheduled input, and `Sandbox` owns the external execution environment
lifecycle.

`executeProgram` is an optional model-selected tool, enabled by default, not a
separate service or agent loop. It coordinates the same available tools inside
`doTurn` and returns a compact result; individual calls retain their existing
authorization and policy gates.

History reads and turn execution share the same `AgentSession/{agentId}` state.
AgentNotifications is only the invalidation broker: AgentSession owns history,
Agent owns profile, approvals, and MCP authorization state, and AgentScheduler
owns schedules. A client therefore drains `AgentSession.history`, then parks on
`AgentNotifications.watch`, and re-reads whichever area has a newer version.

## Supported extension surfaces

There are four intended ways to add capability:

1. Add a built-in tool in `session/tools.ts` when it needs active-turn context,
   pending-operation support, Agent state, or the shared sandbox lease.
2. Annotate a separately deployed Restate JSON handler with
   `restate.dev/agent: <tool-name>` when it should remain an independent
   service.
3. Configure a trusted MCP Streamable HTTP endpoint with the explicit
   `stateless` or `stateful` mode that matches its protocol generation.
4. Add a `SandboxProvider` when the file/command contract stays fixed but the
   compute vendor changes.

Adding another service, Virtual Object, abstraction, or state store is not the
default. First identify which current durable owner cannot enforce the new
responsibility safely.
