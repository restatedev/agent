# Restate agent reference: documentation

This directory is the technical guide to the project. It is written for two
audiences:

- engineers who want to understand, run, extend, or evaluate the example; and
- coding agents that need an explicit map of ownership, contracts, and
  invariants before modifying it.

If you are pointing Codex, Claude Code, or another coding agent at the
repository, start with this instruction:

> Read `docs/agent-guide.md` and `docs/README.md`, then read the guide for the
> subsystem you will change. Confirm the current implementation before editing.

## What this project is

This is a reference implementation of a durable agent runtime on Restate. Its
purpose is not to provide a general agent framework. It keeps the important
control flow visible:

- one durable controller per `agentId`;
- one durable invocation per conversation Turn;
- model calls behind scoped admission and retry control;
- parallel foreground tool batches;
- pending tools that survive across model steps;
- explicit queue, steer, interrupt, and selective-cancellation semantics;
- user instructions, model-managed memories, runtime guardrails, and human
  approvals;
- an immutable, cursor-consumable transcript;
- non-destructive conversation and active-Turn context reduction;
- agent-owned schedules;
- an agent-scoped sandbox with local and Modal providers;
- annotation-driven discovery of Restate handlers as model tools; and
- durable black-box protocol evaluations.

The implementation deliberately uses concrete modules rather than a framework
layer. The seams in this repository are ownership boundaries, not extension
points invented in advance.

## System in one diagram

```mermaid
flowchart LR
  C["Client or UI"] -->|"Agent protocol"| A["Agent VO\nkey = agentId"]
  A -->|"one-way Turn.run"| T["Turn service\none invocation = one turnId"]
  A -.->|"steering, interrupt,\napproval signals"| T
  T -->|"one bounded step at a time"| S["agentStep"]
  S -->|"scoped RPC"| G["ModelGateway"]
  G --> O["OpenAI"]
  S -->|"spawn built-ins in parallel"| B["Built-in tools\ninside Turn"]
  S -->|"durable restate.call"| D["Discovered Restate handlers"]
  B -->|"lazy lease"| X["Sandbox VO\nkey = agentId"]
  X --> P["Local or Modal provider"]
  T -->|"progress, execution, outcome"| A
  A -->|"cursor + watch"| C
  E["Evals"] -->|"same public protocol"| A
```

## The five Restate services

| Service | Shape | Identity | Responsibility |
| --- | --- | --- | --- |
| `Agent` | Virtual Object | `agentId` | Durable controller, transcript, active Turn, queue, profile, approvals, schedules, compaction coordination |
| `Turn` | Service | invocation ID is `turnId` | One durable transient agent loop, model context, steering, interruption, budgets, and pending tools |
| `ModelGateway` | Service called through scope `openai` | scoped invocation + limit key | Admission control, cancellation propagation, durable retries, and provider-call boundary |
| `Sandbox` | Virtual Object | same `agentId` | Serialized lifecycle and one-Turn lease for an Agent-owned external sandbox |
| `Evals` | Service | suite invocation | Concurrent black-box protocol scenarios against fresh Agents |

Only `Agent` and `Sandbox` own Virtual Object state. `Turn` owns durable
invocation-local variables through Restate's journal, not a database or object
state. `ModelGateway` and `Evals` are stateless services.

## Documentation map

Read in this order when learning the entire project:

1. [Coding-agent guide](agent-guide.md) — source-of-truth rules, invariants,
   common traps, and a change-routing map.
2. [Architecture and data flow](architecture.md) — service boundaries, state
   ownership, sequences, transcript, profile, compaction, and failure behavior.
3. [Agent protocol](protocol.md) — supported external handlers, internal
   coordination handlers, request/response shapes, cursor consumption, and
   transcript entry contract.
4. [Turn runtime](turn-runtime.md) — the detailed state machine, steering,
   interruption, guardrails, pending operations, and finalization semantics.
5. [Tools](tools.md) — the built-in tool contract, adding a tool, foreground
   versus pending behavior, and dynamic Restate handler discovery.
6. [Sandboxes](sandboxes.md) — lifecycle, provider contract, local adapter,
   Modal adapter, and adding another provider.
7. [Development and verification](development.md) — setup, local operation,
   evals, validation, troubleshooting, and change checklists.
8. [Evals](evals.md) — suite protocol, isolation, current scenarios, and
   extension ideas.

The root [README](../README.md) remains the feature overview and runnable demo
guide. [PROJECT.md](../PROJECT.md) is a short source map. The documents here
are the maintainer reference.

## Canonical source files

Documentation explains the implementation; it does not replace the executable
contracts. When prose and code differ, use this order:

1. Zod handler and signal schemas in
   [`types.ts`](../packages/libs/example/src/types.ts), the schemas adjacent to
   handlers, and [`model.ts`](../packages/libs/example/src/model.ts);
2. handler control flow in
   [`agent.ts`](../packages/libs/example/src/agent.ts),
   [`turn.ts`](../packages/libs/example/src/turn.ts), and
   [`sandbox.ts`](../packages/libs/example/src/sandbox.ts);
3. focused component modules such as `agent-history.ts`, `agent-turn.ts`,
   `turn-step.ts`, `turn-pending.ts`, and `agent-tools.ts`;
4. these documents.

If a change intentionally alters behavior, update the schema, implementation,
eval coverage, and relevant document in the same change.

## The shortest useful mental model

`Agent` decides **when and where a user message runs**. `Turn` decides **how to
fulfil the active set of messages**. `agentStep` performs **one
model → guardrail → foreground-tool transition**. `agentTools` owns **tool
schemas and execution mechanics**. `ModelGateway` owns **provider admission and
retry behavior**. `Sandbox` owns **the external workspace lifecycle**.

The canonical transcript belongs to `Agent` and is an immutable event log.
Turn working messages are a transient execution projection. A conversation
summary and active-Turn reduction are derived context; neither replaces or
rewrites the transcript.

## Supported extension surfaces

There are three intended ways to add capability:

1. Add a built-in tool in `agent-tools.ts` when it belongs inside this runtime,
   needs direct access to Turn context, or participates in the pending-operation
   protocol.
2. Annotate a separately deployed Restate JSON handler with
   `restate.dev/agent: <tool-name>` when the capability should remain an
   independent service.
3. Add a `SandboxProvider` when the file/command contract is stable but the
   underlying compute vendor changes.

Adding another service, Virtual Object, abstraction, or state store is not the
default. First identify which existing owner cannot safely own the new
responsibility.
