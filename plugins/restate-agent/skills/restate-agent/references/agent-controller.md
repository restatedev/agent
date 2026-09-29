# Customize the Agent controller

Use this when a request changes how a conversation starts, accepts input while
busy, ends, exposes state, or coordinates children. `Agent` is a virtual object
keyed by `agentId`. Its exclusive handlers serialize control decisions;
`AgentSession.doTurn` executes the model loop and owns history. Paths below are
relative to `packages/libs/core/src/` unless they begin at the repository root.
Read `docs/agent-guide.md`, `docs/architecture.md`, and the affected modules
before editing. `docs/protocol.md` is the source for public wire behavior.

## Route input and reconcile a turn

`agent/turns.ts` owns entry and completion; `agent/active-turn.ts` owns the
active invocation ID, pending FIFO, and its signals. `agent/start-turn.ts`
reads the current profile and MCP references, then starts
`AgentSession.doTurn` with a **one-way send**. Never hold Agent's exclusive
lock while waiting for the turn it started.

| Request | Idle Agent | Busy Agent |
| --- | --- | --- |
| `ask` | Start a turn | Queue the user message FIFO; it does not steer |
| `steer` | Return `false` | Move queued entries plus the new instruction into an ordered signal, without cancelling current tool work |
| `interrupt` | Return `false` | Signal graceful interruption; optional replacement input queues for a successor turn |
| `deliver` | Start a turn | Apply the producer's explicit `queue`, `steer`, or `interrupt` policy |

A coalescing delivery with a `sourceId` is skipped while the same
`source`/`sourceId` pair is already queued or active. Once interruption has begun, later deliveries queue
instead of steering or interrupting again. The pending queue and per-turn
steering batches each have a bound of 32; preserve the 429 behavior when
changing their representation.

`onTurnEnd` is the reconciliation point, not merely a callback. It accepts
only the current turn ID; stale or repeated outcomes return `null`. It uses
`consumedSteering` to put unconsumed steering ahead of the remaining pending
queue, applies a late accepted interrupt to an otherwise completed or stopped
outcome, stops that turn's child tasks, and clears its approvals. Only then
may it start a successor. If a terminal error (for example, invalid MCP
configuration) prevents a successor from starting, accepted input is requeued. AgentSession appends the
reconciled outcome to history; Agent never writes that log. Read
`docs/turn-runtime.md#steering` before changing signal ordering or cleanup.

For routing changes, test busy and idle paths, queue order, coalescing, the
32-item bounds, duplicate `onTurnEnd`, unconsumed steering, late interrupt,
and successor-start failure. Start with `packages/libs/core/test/local-agent.test.mjs`.

## Choose handler mode and access boundary

`agent/service.ts` assembles owner modules and assigns each handler its
concurrency mode, ingress visibility, and completed-invocation retention.

| Caller or behavior | Mode and check |
| --- | --- |
| Mutate Agent state | Exclusive handler; validate its precondition explicitly with `agent/guards.ts` |
| Read state while a turn is active, or long-poll | Shared handler using `restate.sharedState()`; it must not write Agent state |
| Direct UI/ingress mutation of a top-level agent | `requireDirectAccess()` checks live and top-level; the backend must additionally check user ownership if an app layer is added |
| Internal turn callback | `ingressPrivate` plus the current, non-interrupting `turnId`; use `requireTurnTool` when the handler must independently enforce a named built-in grant, or `activeTurn.accepting` when dispatch has already enforced the grant |
| Parent/child coordination | `ingressPrivate`, with exact parent identity and child turn checks |

`shared` is a concurrency choice, not permission to expose data to any
caller. Read-only handlers in this local reference rely on trusted ingress;
a multi-user backend must authorize reads as well as writes. Keep
`ingressPrivate` on coordination handlers that would bypass turn or grant
checks if invoked directly.

Use the existing policies in `retention.ts` when registering a handler:
`askRetention`, `interactionRetention`, `coordinationRetention`, or
`noRetention`. They govern **completed invocation** journals and idempotency
records, not Agent state or an active turn. Pick retention for the caller's
retry/duplicate semantics; do not add a new handler without an explicit
choice in `agent/service.ts`. See `references/agent-handlers.md` for the
contract, client, UI, and test steps.

## Create, snapshot, and retire an Agent

A top-level agent may be created implicitly by its first `ask`, or configured
first with `initialize({name, profile?})`. `initialize` is retry-safe and
keeps parent metadata immutable. `agent/start-turn.ts` snapshots
instructions, guardrails, tool grants, web-search preference, memory count,
and allowed MCP references before recording the active turn. Profile edits
apply on the next turn; memory tools read and write live Agent state during
the current one. `agent/profile.ts`, `agent/memories.ts`, and
`agent/guards.ts` own these boundaries.

`retire` in `agent/lifecycle.ts` marks the ID deleted so it cannot be started
again. It drops queued input; stops child tasks; interrupts the active turn;
clears approvals, schedules, profile, and memories; retires children; and
one-way sends `AgentSession.retire`. Keep metadata for idempotent retirement
and the active turn until it reports its terminal outcome. The session
retirement queues behind that turn, which still needs to call Agent. Retained
conversation history is not a data-purge API. Test repeat retirement, late
callbacks, and cleanup that races a running turn.

## Delegate without widening access

`agent/sub-agents.ts` stores direct children and the exact child turns started
by parent tool calls. Child IDs derive from parent ID, turn ID, and tool-call
ID, so retries name the same child. A child receives a creation-time copy of
instructions, guardrails, and effective grants, possibly narrowed by the
parent request; its memory starts empty. It cannot create children or
schedules, and new MCP connections are not automatically granted.

Parent handlers validate the live turn and requested tool, then record the
child invocation ID. The parent **session** waits for that invocation; the
controller stays responsive. Interruption, turn end, deletion, or an
abandoned program branch must stop only the recorded child turn, never a
newer follow-up. Child-side handlers verify the owning parent; cleanup checks
the exact child turn. Direct users may inspect, approve, or interrupt a child
but do not submit its
tasks. Read `docs/tools.md#sub-agents` and test with
`packages/libs/core/test/sub-agent-delegation.test.mjs` and
`packages/libs/core/test/sub-agent.test.mjs`.

## Notify clients without duplicating state

`agent/notifications.ts` stores a global revision and watermarks for
`history`, `profile`, `approvals`, and `schedules`. A writer publishes its
topic; AgentSession sends `publish("history")` after appending history.
Notifications contain invalidation only. Read authoritative history from
AgentSession and other current state from Agent.

`watch` is shared so its wait does not block Agent's exclusive lock. Its
exclusive `subscribe` rechecks the revision before parking the watcher,
closing the read/subscribe race. Timeout removes the subscription;
cancellation sends an unsubscribe. A client captures a revision **before** reading state, drains
sequenced history pages, then watches from that revision and re-reads changed
topics. A new topic needs a schema key, stored watermark, publisher, and
client invalidation path. Read `docs/protocol.md#history-and-notifications`
and test missed-update and timeout paths in
`packages/libs/core/test/local-agent.test.mjs`.
