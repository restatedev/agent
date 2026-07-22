# Project overview

This repository is a small reference implementation of a durable AI agent on
[Restate](https://restate.dev/). Its purpose is to show the essential pieces of
an agentic application—conversation state, turn execution, steering,
interruption, model calls, and tools—without introducing an agent framework.

## How it works

The application is split into four concrete parts:

- **`Agent`** is a Virtual Object keyed by `agentId`. It owns the durable
  conversation history, tracks the active turn, queues new messages, and holds
  pending human approvals. Alongside the conversation handlers, `approvals`
  and `resolveApproval` expose the human-in-the-loop boundary.
- **`Turn`** is a stateless service invocation that supervises one turn. It
  runs the agent loop and listens for durable interruption. The loop consumes
  steering cooperatively, preserving completed tool results and closing
  unfinished calls with cancellation outcomes before applying the instruction.
- **`agentLoop`** performs a bounded model → tools → model cycle. Tool
  definitions are self-contained here: each tool includes its description,
  input schema, and local durable implementation. Independent tool calls are
  spawned in parallel.
- **`ModelGateway`** performs full model inference behind Restate's scoped
  concurrency controls. A separate cheap model classifies messages that arrive
  during an active turn as `steer`, `interrupt`, or `queue`.

```text
user → Agent → Turn → agentLoop → ModelGateway
         ↑          ↕ tools
         └── outcome / signals
```

The controller stores only user-facing messages and the final outcome of each
turn. Intermediate model responses and tool calls remain visible through
Restate's invocation journal instead of becoming conversation history.

## Why Restate is useful here

Restate provides the application-level guarantees that an agent needs:

- durable conversation state and serialized controller decisions;
- one-way invocation of long-running turns;
- queued signals for steering and interruption;
- durable sleeps, retries, and local tool operations;
- durable signal-backed human approval;
- deterministic concurrent execution of independent tools;
- concurrency limits around model traffic;
- an observable invocation tree for the complete turn.

## Source map

- `packages/libs/example/src/agent.ts` — conversation controller
- `packages/libs/example/src/agent-approval.ts` — pending approval state and signals
- `packages/libs/example/src/turn.ts` — turn lifecycle and signals
- `packages/libs/example/src/agent-loop.ts` — agent loop and tools
- `packages/libs/example/src/model.ts` — AI SDK integration
- `packages/libs/example/src/model-gateway.ts` — scoped model gateway
- `packages/libs/example/src/types.ts` — public wire types and schemas
- `packages/libs/example/src/app.ts` — service endpoint

See [`README.md`](./README.md) for setup instructions, example invocations, and
the detailed durability and flow-control behavior.
