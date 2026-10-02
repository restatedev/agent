# Customize the Agent controller

Use this when a request changes how a conversation starts, takes input while
busy, ends, exposes state, or coordinates children.

`Agent` is a virtual object keyed by `agentId`. Its exclusive handlers
serialize control decisions. `AgentSession.doTurn` runs the model loop and
owns the history. Read `docs/agent-guide.md`, `docs/architecture.md` and the
modules you change before editing. `docs/protocol.md` is the source for the
public wire behavior.

## Route input and reconcile a turn

| Module | Owns |
| --- | --- |
| `agent/turns.ts` | Entry points and turn end |
| `agent/active-turn.ts` | The active turn ID, the pending queue, the signals to the turn, and the one-way send that starts `doTurn` |
| `agent/start-turn.ts` | The snapshot a turn starts with |

The controller never waits for the turn it started. It starts `doTurn` with
a one-way send, so the turn can call back into `Agent` while it runs.

| Request | Idle agent | Busy agent |
| --- | --- | --- |
| `ask` | Start a turn | Queue the message; it does not steer |
| `steer` | Return `false` | Send the queued entries and the new instruction to the turn as one batch, without cancelling tools. Return `false` if the turn is already interrupting |
| `interrupt` | Return `false`; a `message` is dropped | Signal a graceful stop and stop the turn's child tasks. A `message` queues for the next turn |
| `deliver` | Start a turn | Apply the producer's `whenBusy`: `queue`, `steer` or `interrupt` |

Details that are easy to break:

- A second `interrupt` returns `false`, unless it carries a `message`,
  which is queued.
- Once an interrupt has begun, later deliveries queue instead of steering
  or interrupting again.
- A coalescing delivery is skipped while one with the same
  `source`/`sourceId` pair is queued or part of the active turn.
- The pending queue holds at most 32 user messages. Deliveries do not count
  towards that limit, and requeued input bypasses it.
- A turn takes at most 32 steering batches.
- Both limits reject with 429. Keep that when changing how they are stored.

### Turn end

`onTurnEnd` is where the controller reconciles a finished turn. In order:

1. It accepts only the current turn ID. A stale or repeated outcome returns
   `null`.
2. It uses `consumedSteering` to put the steering the turn never saw ahead
   of the rest of the queue.
3. A late interrupt turns a `completed` or `stopped` outcome into an
   interrupted one.
4. It stops the turn's child tasks and clears its approvals.
5. Only then does it start the next turn. If that start fails with a
   terminal error (for example, invalid MCP configuration), the accepted
   input is requeued.

`AgentSession` appends the reconciled outcome to the history; `Agent` never
writes the history. Read `docs/turn-runtime.md#steering` before changing
the signal order or the cleanup.

For routing changes, test in `test/local-agent.test.mjs`:

- the busy and idle paths, and the queue order;
- coalescing and both 32-item limits;
- a duplicate `onTurnEnd`, unconsumed steering and a late interrupt;
- a failed start of the next turn.

## Choose handler mode and access

`agent/service.ts` puts the owner modules together. It gives each handler
its concurrency mode, its ingress visibility and its retention.

| Caller | Mode and check |
| --- | --- |
| A mutation of Agent state | Exclusive. Check the precondition with a guard from `agent/guards.ts` |
| A read while a turn is active, or a long poll | Shared, with `restate.sharedState()`. It never writes Agent state |
| A direct UI or ingress mutation of a top-level agent | `requireDirectAccess()`: the agent is live and top-level. Child interruption and approval resolution have their own checks |
| A tool in the active turn | `ingressPrivate`, and the tool's current, non-interrupting `turnId`. Use `requireTurnTool(turnId, "toolName", ...)` when the handler must enforce a tool grant itself, or `activeTurn.accepting(turnId)` when the tool dispatch already did |
| A parent or a child agent | `ingressPrivate`, with checks on the exact parent and child turn |

`shared` is a concurrency mode, not permission to expose data. The local
reference trusts ingress. A multi-user backend must authorize reads as well
as writes, and check ownership before every Agent call. Keep
`ingressPrivate` on coordination handlers that would bypass the turn or
grant checks if called directly.

Pick a retention policy from `retention.ts` for every new handler:
`askRetention`, `interactionRetention`, `coordinationRetention` or
`noRetention`. (`executionRetention` is for `AgentSession`'s long
invocations.) Retention governs the journals and idempotency records of
**completed** invocations, not Agent state or an active turn. Choose it for
the caller's retry and duplicate semantics.

`references/agent-handlers.md` has the steps for the contract, the client,
the UI and the tests.

## Create, snapshot and retire an agent

A top-level agent is created by `initialize({name, profile?})`, or
implicitly by its first `ask` or `deliver` (a schedule firing is a
delivery).

- `initialize` is safe to retry, and the parent is immutable.
- After an implicit creation, `initialize` does nothing: its name and
  profile are ignored.

`agent/start-turn.ts` snapshots the turn's inputs before it records the
active turn:

- the instructions and guardrails;
- the tool grants and the web-search preference;
- the memory count;
- the references of the allowed MCP servers.

Profile edits apply from the next turn. Memory tools read and write live
Agent state during the current turn. `agent/profile.ts`,
`agent/memories.ts` and `agent/guards.ts` own these boundaries.

`retire` (`agent/lifecycle.ts`) marks the ID deleted, so it cannot start
again. Then it:

1. drops the queued input;
2. stops child tasks and interrupts the active turn;
3. clears approvals, schedules, the profile and memories;
4. retires the children;
5. sends `AgentSession.retire` one way.

It keeps the metadata, so a repeated retire is a no-op, and it keeps the
active turn until that turn reports its outcome. `AgentSession.retire`
queues behind that turn, which still needs to call `Agent`. The retained
history is not a data-purge API.

Test a repeated retire, late callbacks, and cleanup that races a running
turn (`test/agent-deletion.test.mjs`).

## Delegate without widening access

`agent/sub-agents.ts` stores the direct children and the exact child turns
that parent tool calls started.

- A child ID derives from the parent ID, the turn ID and the tool call ID,
  so a retry names the same child.
- A child gets a copy of the parent's instructions, guardrails and grants
  at creation, possibly narrowed by the parent. Its memory starts empty.
- A child cannot create children or schedules. New MCP servers are not
  granted to it automatically.
- Parent handlers check the live turn and the tool, then record the child's
  invocation ID. The parent **session** waits for that invocation, so the
  controller stays responsive.
- An interrupt, the turn's end, deletion or an abandoned program branch
  stops only the recorded child turn, never a newer one.
- Users may inspect a child, resolve its approvals and interrupt it, but
  not give it tasks.

Read `docs/tools.md#sub-agents`. Test with
`test/sub-agent-delegation.test.mjs` and `test/sub-agent.test.mjs`.

## Notify clients without copying state

`agent/notifications.ts` stores a global revision and a watermark for each
topic: `history`, `profile`, `approvals` and `schedules`.

- A module that writes a topic publishes it. `AgentSession` publishes
  `history` after it appends to the history.
- A notification carries revisions, never data. Read the history from
  `AgentSession` and everything else from `Agent`.
- `watch` is shared, so its wait does not hold the Agent's lock. Its
  exclusive `subscribe` checks the revision again before parking, which
  closes the race between reading and subscribing. A timeout removes the
  subscription, and cancellation sends an unsubscribe.

A client syncs like this. In the reference UI, the Next.js server does it
for the browser (`packages/apps/web/src/server/agent-snapshot.ts`):

1. Capture a revision **before** reading any state.
2. Read the state, and page through the sequenced
   `AgentSession.history`.
3. Call `watch({afterRevision})`, then re-read only the topics that
   changed.

A new topic needs a key in `AgentNotificationTopicSchema`, a stored
watermark, a publisher and a client path that re-reads it. Read
`docs/protocol.md#history-and-notifications`, and test missed updates and
timeouts in `test/local-agent.test.mjs`.
