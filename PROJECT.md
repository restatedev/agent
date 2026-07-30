# Project overview

This repository is a small reference implementation of a durable AI agent on
[Restate](https://restate.dev/). Its purpose is to show the essential pieces of
an agentic application—conversation state, turn execution, steering,
interruption, model calls, and tools—without introducing an agent framework.

## How it works

The application is split into a few concrete parts:

- **`Agent`** is a Virtual Object keyed by `agentId`. It owns the durable
  conversation history, tracks the active turn, routes queued messages, and
  owns the persistent instructions, memories, guardrails, and pending human
  approvals. It also owns durable one-shot and fixed-interval messages:
  delayed self-sends return through the same exclusive routing decision as
  ordinary input. Every message and lifecycle event is recorded when its exclusive
  handler observes it; pending state controls execution without reordering the
  transcript. Alongside the conversation handlers, `profile` exposes durable
  prompt context, while `approvals` and `resolveApproval` expose the
  human-in-the-loop boundary. Profile-change metadata, approval requests and
  cancellations, semantic progress, concise model-authored activity, and
  structured tool lifecycle are appended to the same sequenced transcript,
  which clients consume through the cursor-based `history` handler. `ask`
  starts work when idle and queues when busy; clients explicitly select
  `steer` or `interrupt` when they want to affect the active turn. Interruption
  can atomically preserve a replacement user message for a new Turn after the
  old Turn finishes graceful finalization.
- **`Turn`** has no service state, but one durable invocation owns the
  transient agent-turn state machine: live messages, budgets, steering, and
  pending operations. It repeatedly spawns one bounded agent step, applies its
  returned data, and retains completed work for a tool-free interruption
  response. Runtime execution limits use a distinct `stopped` outcome rather
  than masquerading as interruption. Each invocation receives the canonical
  transcript, where steering metadata, queue dispatch, and interruption reasons
  become explicit model-context boundaries.
- **`agentStep`** is the functional model → foreground-tools seam. It receives
  a message snapshot and remaining tool budget, asks a cheap policy model to
  gate the agent model's proposed text or complete tool batch, runs an allowed
  batch in parallel, and owns no work after returning. A policy may allow,
  deny, or durably wait for human approval. `turn-steering.ts` drains durable
  steering signals into a Turn-scoped inbox, while `turn-pending.ts` owns
  long-lived sleeps and approvals across steps. The model can selectively stop
  those tasks through `cancelOperation`; progress and execution activity remain
  visible in the canonical transcript but are omitted from future model context
  and compaction input. Model-relevance for derived transcript events is
  classified once in the shared conversation contract instead of being
  duplicated by each projection.
- **Dynamic Restate tools** are snapshotted once when a Turn starts. Handlers
  opt in with `restate.dev/agent: <tool-name>` metadata; a replica-local,
  coalescing cache refreshes infrequently from the Admin API. The journaled
  snapshot supplies JSON schemas and exact invocation targets to both the
  model and executor without a globally hot Restate key. Selected tools run as
  durable generic Restate calls in the ordinary foreground batch.
- **`ModelGateway`** performs full agent inference, cheap guardrail evaluation,
  and active-Turn context reduction behind Restate's scoped concurrency
  controls, model-specific limit keys, retry policy, and cancellation
  propagation.
- **`Sandbox`** is a Virtual Object keyed by `agentId`. Sandbox tools borrow it
  lazily for their Turn; it provisions or resumes through a provider, and Turn
  release schedules a cancellable idle suspension. The included provider uses
  `/tmp/restate-agent-sandboxes/<agentId>` as a local demo workspace shared by
  every conversation Turn for that Agent. File operations and commands are
  one-shot foreground calls, with intentional asynchronous work left to
  explicit shell scripts. Successful provisioning and suspension transitions
  are appended to the Agent transcript for clients, but omitted from model
  context.
- **`Agent.compact`** is a shared handler that asynchronously summarizes older
  finished turns without blocking conversation updates. The model operation
  lives in `conversation-compactor.ts`; the summary is derived context and the
  chunked Agent transcript remains complete and authoritative.
- **`Evals`** exposes one `all` handler that concurrently drives isolated Agents
  through the public protocol and returns structured assertions with their
  observed transcripts.

All handlers on `Agent`, `Turn`, `ModelGateway`, `Sandbox`, and `Evals` are
ingress-public so the complete protocol is easy to inspect. Normal clients
should still use only the conversation and approval handlers; the others are
service coordination paths.

```text
user/UI → Agent → Turn → agentStep → ModelGateway
            ↻ delayed schedules
            ↑         ↕ allowed tools → Sandbox
            └── outcome, progress, approvals, and signals
```

The controller stores user messages, final answers, failures, lifecycle
boundaries, semantic progress, short activity, and structured tool names and
statuses in one ordered transcript. Raw reasoning, tool arguments and results,
and intermediate model messages remain visible through Restate's invocation
journal instead of becoming conversation entries. Compaction preserves failure
and interruption boundaries while older turns are summarized for model context
without being removed from the canonical transcript.

## Why Restate is useful here

Restate provides the application-level guarantees that an agent needs:

- durable conversation state and serialized controller decisions;
- one cursor-consumable sequence for messages, lifecycle events, progress, and
  structured execution activity;
- history-based invalidation for profile snapshots and complete pending
  approval lifecycle notifications;
- lazy, chunked transcript storage and asynchronous summary checkpoints;
- one-way invocation of long-running turns;
- durable signals for steering, interruption, and human approval;
- durable sleeps, retries, and local tool operations;
- durable Agent-owned scheduled messages with queue, steer, or interrupt
  delivery;
- turn-scoped pending timers and signal-backed human approval;
- a fail-closed policy gate before publishing text or starting tool batches;
- deterministic concurrent execution of independent tools;
- annotation-driven discovery and durable invocation of third-party Restate
  handlers;
- durable ownership and idle lifecycle for an agent-scoped sandbox;
- concurrency limits around model traffic;
- an observable invocation tree for the complete turn.

## Source map

- `packages/libs/example/src/agent.ts` — conversation controller
- `packages/libs/example/src/agent-history.ts` — durable user-facing transcript
- `packages/libs/example/src/agent-profile.ts` — durable instructions, memories,
  and natural-language guardrails
- `packages/libs/example/src/agent-schedules.ts` — Agent-owned scheduled messages
- `packages/libs/example/src/agent-turn.ts` — active-turn state and signal delivery
- `packages/libs/example/src/agent-approval.ts` — pending approval state and signals
- `packages/libs/example/src/turn.ts` — transient turn state machine and signals
- `packages/libs/example/src/turn-context.ts` — transcript-to-model projection
- `packages/libs/example/src/turn-step.ts` — bounded step execution, policy gating, and supervision
- `packages/libs/example/src/turn-steering.ts` — Turn-scoped steering inbox
- `packages/libs/example/src/turn-pending.ts` — cross-step pending tool tasks
- `packages/libs/example/src/agent-tools.ts` — concrete tools and result projection
- `packages/libs/example/src/dynamic-tools.ts` — annotated Restate handler tools
- `packages/libs/example/src/sandbox.ts` — agent-scoped sandbox lifecycle
- `packages/libs/example/src/sandbox-provider.ts` — provider and one-shot client contracts
- `packages/libs/example/src/conversation-compactor.ts` — compaction model operation
- `packages/libs/example/src/model.ts` — agent, guardrail, and Turn-context AI SDK integration
- `packages/libs/example/src/model-gateway.ts` — scoped model gateway
- `packages/libs/example/src/eval.ts` — durable black-box protocol evaluations
- `packages/libs/example/src/client.ts` — typed HTTP mini-client and transcript
  projection for external consumers
- `packages/libs/example/src/types.ts` — shared wire contracts and schemas
- `packages/libs/example/src/app.ts` — Agent, Turn, Sandbox, gateway, and eval endpoint

See [`README.md`](./README.md) for setup instructions, example invocations, and
the detailed durability and flow-control behavior.
