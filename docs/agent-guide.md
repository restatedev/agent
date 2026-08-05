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
   - built-in or discovered tools: [tools](tools.md);
   - sandbox lifecycle: [sandboxes](sandboxes.md);
   - validation or evals: [development](development.md) and [evals](evals.md).
5. State the behavior you intend to preserve before refactoring control flow.

## Source-of-truth order

Use executable contracts before prose:

1. Public Zod schemas in `packages/libs/types/src/index.ts`, shared Restate
   descriptors in `packages/libs/types/src/services.ts`, schemas adjacent to
   internal handlers, and `src/gateway/model.ts`;
2. handler code in `src/agent/service.ts`, `src/session/service.ts`,
   `src/gateway/service.ts`, and `src/sandbox/service.ts`;
3. focused ownership modules;
4. docs.

When behavior changes, update all affected layers. A docs-only description of
an unimplemented behavior is a bug.

## Non-negotiable invariants

Preserve these unless the requested change explicitly replaces them:

1. `Agent` is the only durable controller for an `agentId`. Its exclusive
   handlers serialize the active invocation, pending input, profile, approval,
   and schedule decisions. It does not own conversation history.
2. `AgentSession`, keyed by the same `agentId`, owns the canonical transcript
   and summary checkpoint. The transcript is append-only; never rewrite an
   existing user entry to explain later routing.
3. At most one `AgentSession.doTurn` invocation is active for an Agent. Its
   Restate invocation ID is the stable `turnId` and signal target.
4. A turn receives a stable profile snapshot. Instructions, memories, and
   guardrails changed during that turn affect the next turn. The session loads
   its conversation context once at the beginning of `doTurn`.
5. Steering does not cancel the current model/tool step or existing pending
   operations. It is consumed after the current step settles.
6. Interruption ends the turn gracefully: stop and join unfinished work,
   retain completed results, and perform one tool-free finalization call.
7. External invocation cancellation reconciles Sandbox and Agent ownership,
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
15. `Sandbox` belongs to the Agent across turns. A turn only borrows one lazy
    lease and always releases it at its terminal boundary.
16. A discovered Restate handler is a foreground dynamic tool. The catalog
    snapshot used for model inference is the same snapshot used for execution.
17. Keep the layers distinct in prose and code comments: `Agent` is the
    deterministic controller, `AgentSession` owns session history and turn
    execution, one `doTurn` invocation is an agent run, `agentStep` is one loop
    iteration, and the model plus harness/runtime is the operational agent.

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
- Process-local caches (`session/dynamic-tools.ts`, provider clients) are
  optimizations, never durable sources of truth.
- A sandbox reference carries its provider. Changing `SANDBOX_PROVIDER` does
  not migrate an already-provisioned Agent sandbox.
- The local sandbox is not a security boundary. The Modal adapter is remote
  isolated compute, but its persistent Volume is still Agent-owned data.
- Dynamic handler annotations are a trusted cluster capability boundary:
  documentation enters the model prompt and the handler can be invoked with
  the agent service's authority.
- AgentSession history is the public conversation event log, not the complete
  agent trajectory or Restate execution trace. The `transcript` wire name is
  retained in evaluation results.
- History is not the invalidation mechanism for every current-state area.
  Drain `AgentSession.history`, then use Agent notification versions to decide
  whether to re-read history, profile, approvals, or schedules.
- `activity` and `progress` are status communication, not chain-of-thought or
  model reasoning.
- The per-Agent `memories` collection is persistent semantic/profile memory.
  Active-turn messages are working context, and conversation history is a separate
  canonical log.

## Where a change belongs

| Change | Primary owner |
| --- | --- |
| User message routing and public controller handler | `agent/service.ts` |
| Active turn ID, pending user queue, signal delivery/reconciliation | `agent/active-turn.ts` |
| History chunks, cursor, writer, summary checkpoint | `session/history.ts` |
| Notification revisions, subscriptions, and awakeables | `agent/notifications.ts` |
| Instructions, memories, guardrails | `agent/profile.ts` |
| Pending approval state and decision signal | `agent/approval.ts` |
| Durable scheduled-message state | `agent/schedules.ts` |
| Cross-step loop, transcript append, step bound, and finalization | `session/service.ts` |
| One model/guardrail/foreground-tool transition | `session/step.ts` |
| Steering signal receiver and transient FIFO | `session/steering.ts` |
| Pending tool tasks and cancellation races | `session/pending.ts` |
| Built-in tool schema, execution, result projection | `session/tools.ts` |
| Transcript-to-model projection | `session/context.ts` |
| Dynamic Restate tool discovery | `session/dynamic-tools.ts` |
| AI SDK provider behavior and model contracts | `gateway/model.ts` |
| Restate model admission, limit keys, retries | `gateway/service.ts` |
| Agent sandbox lifecycle | `sandbox/service.ts` |
| Provider contract and provider selection | `sandbox/provider.ts` |
| Local filesystem demo adapter | `sandbox/local-provider.ts` |
| Modal-specific compute/storage | `sandbox/modal-provider.ts` |
| Black-box protocol coverage | `eval.ts` |
| External HTTP consumption | `packages/libs/client/src/index.ts` |

If a proposed change spans several rows, keep each responsibility in its owner.
Avoid a generic abstraction unless two concrete implementations need the same
contract.

## How to add capability safely

### Built-in tool

Read [tools.md](tools.md). Keep name, description, Zod schema, execution, and
pending completion together in `session/tools.ts`. Add it to `definitions`,
preserve cancellation errors, and add a focused eval when behavior affects the
Agent protocol.

### Dynamic Restate tool

Do not link it into this package. Annotate its deployed handler with
`restate.dev/agent`, provide accurate handler documentation and JSON schemas,
and ensure JSON-compatible serialization. Read the security and collision rules
in [tools.md](tools.md).

### New Agent handler

Define input and output Zod schemas, decide whether it is a supported client
handler or internal coordination path, choose exclusive versus shared state
semantics, update `packages/libs/client/src/index.ts` if external, document its
state and transcript effects, and add protocol coverage.

### New transcript event

Update `ConversationEventSchema`, then make an explicit exhaustive decision in
`isDerivedConversationEvent`. Update `session/context.ts`,
`gateway/compactor.ts`, external consumers, protocol docs, and eval
assertions as applicable. Never let different consumers silently invent their
own relevance policy.

### New sandbox provider

Implement `SandboxProvider` without moving lifecycle state out of `Sandbox`.
Provider calls and client methods are external effects and must run under
`restate.run` with bounded, idempotent behavior. Read [sandboxes.md](sandboxes.md).

## Validation expected after changes

Run checks proportional to the change, normally:

```sh
pnpm lint
pnpm build
pnpm bundle
git diff --check
```

For protocol changes, run the smallest relevant `Evals/all` subset first, then
the complete suite when cost and runtime are justified. Evals are probabilistic
where models are involved; assertions should target durable structure and
semantics rather than exact prose.

Review the final diff for:

- redundant exported types or concepts;
- state or effects in the wrong owner;
- accidental transcript rewrites;
- an unjoined spawned task;
- cancellation swallowed as an ordinary failure;
- schemas that no longer match callers;
- stale docs; and
- staged secrets, local state, or unrelated files.
