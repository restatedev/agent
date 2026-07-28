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
  approvals. Every message and lifecycle event is recorded when its exclusive
  handler observes it; pending state controls execution without reordering the
  transcript. Alongside the conversation handlers, `profile` exposes durable
  prompt context, while `approvals` and `resolveApproval` expose the
  human-in-the-loop boundary. Semantic progress is appended to the same
  sequenced transcript, which clients consume through the cursor-based
  `history` handler. `ask` starts work when idle and queues when busy; clients
  explicitly select `steer` or `interrupt` when they want to affect the active
  turn. Interruption can atomically preserve a replacement user message for a
  new Turn after the old Turn finishes graceful finalization.
- **`Turn`** has no service state, but one durable invocation owns the
  transient agent-turn state machine: live messages, budgets, steering, and
  pending operations. It repeatedly spawns one bounded agent step, applies its
  returned data, and retains completed work for a tool-free interruption
  response. Each invocation receives the canonical transcript, where steering
  metadata, queue dispatch, and interruption reasons become explicit
  model-context boundaries.
- **`agentStep`** is the functional model → foreground-tools seam. It receives
  a message snapshot and remaining tool budget, runs independent tool calls in
  parallel, and owns no work after returning. `turn-steering.ts` drains durable
  steering signals into a Turn-scoped inbox, while `turn-pending.ts` owns
  long-lived sleeps and approvals across steps. The model can selectively stop
  those tasks through `cancelOperation`; progress remains visible in the
  canonical transcript but is omitted from future model context and
  compaction input.
- **`ModelGateway`** performs full model inference behind Restate's scoped
  concurrency controls, retry policy, and cancellation propagation.
- **`Agent.compact`** is a shared handler that asynchronously summarizes older
  finished turns without blocking conversation updates. The model operation
  lives in `conversation-compactor.ts`; the summary is derived context and the
  chunked Agent transcript remains complete and authoritative.

All handlers on `Agent`, `Turn`, and `ModelGateway` are ingress-public so the
complete protocol is easy to inspect. Normal clients should still use only the
conversation and approval handlers; the others are service coordination paths.

```text
user/UI → Agent → Turn → agentStep → ModelGateway
            ↑         ↕ tools
            └── outcome, progress, approvals, and signals
```

The controller stores user messages, final answers, failures, lifecycle
boundaries, and semantic progress in one ordered transcript. Intermediate model
responses, tool calls, and tool results remain visible through Restate's
invocation journal instead of becoming conversation entries. Compaction
preserves failure and interruption boundaries while older turns are summarized
for model context without being removed from the canonical transcript.

## Why Restate is useful here

Restate provides the application-level guarantees that an agent needs:

- durable conversation state and serialized controller decisions;
- one cursor-consumable sequence for messages, lifecycle events, and progress;
- lazy, chunked transcript storage and asynchronous summary checkpoints;
- one-way invocation of long-running turns;
- durable signals for steering, interruption, and human approval;
- durable sleeps, retries, and local tool operations;
- turn-scoped pending timers and signal-backed human approval;
- deterministic concurrent execution of independent tools;
- concurrency limits around model traffic;
- an observable invocation tree for the complete turn.

## Source map

- `packages/libs/example/src/agent.ts` — conversation controller
- `packages/libs/example/src/agent-history.ts` — durable user-facing transcript
- `packages/libs/example/src/agent-profile.ts` — durable instructions, memories,
  and capability guardrails
- `packages/libs/example/src/agent-turn.ts` — active-turn state and signal delivery
- `packages/libs/example/src/agent-approval.ts` — pending approval state and signals
- `packages/libs/example/src/turn.ts` — transient turn state machine and signals
- `packages/libs/example/src/turn-context.ts` — transcript-to-model projection
- `packages/libs/example/src/turn-step.ts` — bounded step execution and supervision
- `packages/libs/example/src/turn-steering.ts` — Turn-scoped steering inbox
- `packages/libs/example/src/turn-pending.ts` — cross-step pending tool tasks
- `packages/libs/example/src/agent-tools.ts` — concrete tools and result projection
- `packages/libs/example/src/conversation-compactor.ts` — compaction model operation
- `packages/libs/example/src/model.ts` — AI SDK integration
- `packages/libs/example/src/model-gateway.ts` — scoped model gateway
- `packages/libs/example/src/types.ts` — shared wire contracts and schemas
- `packages/libs/example/src/app.ts` — service endpoint

See [`README.md`](./README.md) for setup instructions, example invocations, and
the detailed durability and flow-control behavior.
