# Project overview

This repository is a small reference implementation of a durable AI agent on
[Restate](https://restate.dev/). Its purpose is to show the essential pieces of
an agentic application—conversation state, turn execution, steering,
interruption, model calls, and tools—without introducing an agent framework.

## How it works

The application is split into a few concrete parts:

- **`Agent`** is a Virtual Object keyed by `agentId`. It owns the durable
  conversation history, tracks the active turn, routes queued messages, and
  holds pending human approvals and a bounded progress feed. Every message is
  recorded when its exclusive handler observes it; pending state controls
  execution without reordering the transcript. Alongside the conversation
  handlers, `approvals` and `resolveApproval` expose the human-in-the-loop
  boundary, while `progress` exposes sequenced semantic milestones. `ask`
  starts work when idle and queues when busy; clients explicitly select
  `steer` or `interrupt` when they want to affect the active turn.
- **`Turn`** is a stateless service invocation that supervises one turn. It
  runs the agent loop and supplies its durable interrupt signal. The loop
  consumes structured steering cooperatively; interruption cancels unfinished
  work but retains completed results for one tool-free final model response.
  Each invocation receives the canonical transcript, where steering metadata,
  queue dispatch, and interruption reasons become explicit model-context
  boundaries.
- **`agentLoop`** performs a bounded model → tools → model cycle. It owns the
  orchestration policy and live task registry, while `agent-tools.ts` keeps
  every concrete tool's description, schema, validation, local durable
  behavior, and result projection together. Independent tool calls are spawned
  in parallel. Long-lived sleeps and approvals remain pending across model
  rounds, allowing steering and unrelated tools to progress around them. The
  model can selectively stop those tasks through `cancelOperation`; a graceful
  interrupt stops everything outstanding and summarizes achieved work. The
  loop one-way reports semantic progress without exposing raw reasoning blocks.
- **`ModelGateway`** performs full model inference behind Restate's scoped
  concurrency controls.
- **`Agent.compact`** is a shared handler that asynchronously summarizes older
  finished turns without blocking conversation updates. The model operation
  lives in `conversation-compactor.ts`; the summary is derived context and the
  chunked Agent transcript remains complete and authoritative.

```text
user → Agent → Turn → agentLoop → ModelGateway
         ↑          ↕ tools
         └── outcome / signals
```

The controller stores only user-facing messages, answers, failures, explicit
interruption events, and graceful interruption responses. Intermediate model
responses, cancelled tool work, and other execution details remain visible
through Restate's invocation journal instead of becoming conversation history.
Compaction preserves failure and interruption boundaries while older turns are
summarized for model context without being removed from that user-facing
transcript.

## Why Restate is useful here

Restate provides the application-level guarantees that an agent needs:

- durable conversation state and serialized controller decisions;
- bounded, sequenced progress state driven by one-way loop reports;
- lazy, chunked transcript storage and asynchronous summary checkpoints;
- one-way invocation of long-running turns;
- queued signals for steering and interruption;
- durable sleeps, retries, and local tool operations;
- durable background timers and signal-backed pending human approval;
- deterministic concurrent execution of independent tools;
- concurrency limits around model traffic;
- an observable invocation tree for the complete turn.

## Source map

- `packages/libs/example/src/agent.ts` — conversation controller
- `packages/libs/example/src/agent-history.ts` — durable user-facing transcript
- `packages/libs/example/src/agent-turn.ts` — active-turn state and signal delivery
- `packages/libs/example/src/agent-approval.ts` — pending approval state and signals
- `packages/libs/example/src/agent-progress.ts` — bounded sequenced progress
- `packages/libs/example/src/turn.ts` — turn lifecycle and signals
- `packages/libs/example/src/agent-loop.ts` — agent loop orchestration
- `packages/libs/example/src/agent-tools.ts` — concrete tools and result projection
- `packages/libs/example/src/conversation-compactor.ts` — compaction model operation
- `packages/libs/example/src/model.ts` — AI SDK integration
- `packages/libs/example/src/model-gateway.ts` — scoped model gateway
- `packages/libs/example/src/types.ts` — shared wire contracts and schemas
- `packages/libs/example/src/app.ts` — service endpoint

See [`README.md`](./README.md) for setup instructions, example invocations, and
the detailed durability and flow-control behavior.
