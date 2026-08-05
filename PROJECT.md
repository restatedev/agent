# Project overview

This repository is a reference implementation of a durable, single-agent
harness and runtime on [Restate](https://restate.dev/). The model and harness
together form the operational agent. The weather domain is intentionally
simple so the example can focus on durable conversation control, model/tool
execution, intervention, policy, resources, and evaluation.

The maintainer documentation starts at
[`docs/README.md`](./docs/README.md). Coding agents should read
[`docs/agent-guide.md`](./docs/agent-guide.md) before modifying the project.

## How it works

- **`Agent`** is the deterministic controller Virtual Object keyed by
  `agentId`. It owns the active `AgentSession.doTurn` invocation ID, queued
  input, persistent instructions/memories/guardrails, pending approvals,
  schedules, and notification subscriptions. `ask` starts work when idle and
  queues while busy; clients use `steer` or `interrupt` to affect active work.
- **`AgentSession`** is a second Virtual Object with the same key. It owns the
  append-only conversation event log and compaction checkpoint. Its exclusive
  `doTurn` handler is one durable agent run; that invocation ID is the
  `turnId`. At turn start it loads conversation state once, appends the
  activated input, and then writes new transcript entries directly while the
  loop runs.
- **Notifications** are an invalidation channel, not another state store.
  `AgentSession` publishes `history` invalidations to `Agent`; Agent also
  publishes profile, approval, and schedule revisions. Clients drain
  `AgentSession.history`, long-poll `Agent.watchNotifications`, and re-read the
  authoritative area whose version changed.
- **`agentStep`** is one bounded model → guardrail → optional foreground-tool
  transition. A step owns and joins its model, policy, approval-wait, and
  foreground tool tasks. `session/steering.ts` receives durable steering
  signals; `session/pending.ts` owns sleeps and explicit approvals that survive
  across steps.
- **Built-in tools** live with their schemas and execution mechanics in
  `session/tools.ts`. Independent Restate handlers can opt in as dynamic tools
  with `restate.dev/agent: <tool-name>` metadata. Discovery uses an
  endpoint-local read-through Admin API cache; each turn journals one stable
  catalog snapshot for both inference and execution.
- **`ModelGateway`** places agent inference, guardrail evaluation, and active
  context reduction behind Restate scopes, model/agent limit keys, retry
  policy, and cancellation propagation.
- **`Sandbox`** is an Agent-scoped Virtual Object. A turn borrows it lazily,
  releases it on every exit path, and leaves the persistent workspace for
  later turns. The default provider is a local `/tmp` workspace; the optional
  Modal provider supplies isolated compute with one persistent Volume per
  Agent.
- **Conversation compaction** runs on shared `AgentSession.compact`, installs
  checkpoints through exclusive `applyCompaction`, and never rewrites or
  deletes transcript chunks. Active-turn context reduction is separate and
  only changes invocation-local model context.
- **`Evals`** concurrently drives fresh agents through the same public protocol
  and returns deterministic structural assertions over the observed transcript
  and state.

```text
client → Agent/{agentId}        controller + notifications
       → AgentSession/{agentId} transcript + doTurn
                    │
                    ├─ agentStep → ModelGateway → model
                    ├─ built-in tools → Agent / Sandbox
                    └─ dynamic tools → Restate handlers
```

## Why Restate is useful here

Restate supplies:

- serialized controller and resource ownership through Virtual Objects;
- durable one-way turn dispatch and signal delivery;
- recoverable model calls, timers, retries, and tool effects;
- deterministic structured concurrency for model steps and tool batches;
- cursor-based durable history plus awakeable-backed invalidation waits;
- scoped model admission control;
- an observable invocation tree for the complete agent run; and
- a natural substrate for black-box, protocol-level evaluations.

## Package map

- `packages/libs/types/` — public wire schemas, service descriptors, and stable
  target names shared by runtime and callers
- `packages/libs/client/` — typed ingress client built on
  `@restatedev/restate-sdk-clients`; it hides the Agent/AgentSession split
- `packages/libs/core/` — Restate services, runtime loop, tools, providers, and
  eval harness

## Core source map

- `src/agent/` — controller service plus active-turn, profile, approval,
  schedule, and notification state
- `src/session/` — transcript owner and turn state machine plus context, tools,
  steering, pending work, and dynamic discovery
- `src/gateway/` — provider-specific inference, model contracts, admission,
  limit keys, retry policy, and conversation compaction
- `src/sandbox/` — Agent-scoped lifecycle, provider contract, and Modal adapter
- `src/eval.ts` — durable black-box protocol evaluations
- `src/app.ts` — executable Restate endpoint

See [`README.md`](./README.md) for the runnable demo and
[`docs/README.md`](./docs/README.md) for detailed contracts.
