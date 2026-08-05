# Agent protocol and conversation event-log contract

This document describes the Restate ingress contract. Public Zod schemas in
`packages/libs/types/src/index.ts` and service descriptors in
`packages/libs/types/src/services.ts` are authoritative.

The API uses `history`, `ConversationEntry`, and `transcript` for the public
**conversation event log**. It is not the complete model/tool trajectory or
Restate execution trace.

## Addressing and serialization

One logical agent uses the same `agentId` as the key of two Virtual Objects:

```text
POST <ingress>/Agent/<agentId>/<handler>
POST <ingress>/AgentSession/<agentId>/<handler>
```

`Agent` is the controller and current-state API. `AgentSession` owns history
and executes turns. The typed client in
`packages/libs/client/src/index.ts` wraps both, so normal callers do not need
to manage this split.

All non-void requests use JSON. A void-input handler must receive an empty body
without `content-type`; `{}` with `application/json` is not equivalent. Use an
`idempotency-key` header when retrying one logical request, especially a
long-poll window.

Every handler is ingress-visible for inspection, but only the supported API
below is intended for application clients.

## Supported conversation API

### `Agent.ask`

Input:

```ts
{message?: string}
```

An omitted message uses the demo default. While idle, Agent snapshots the
profile and one-way starts `AgentSession.doTurn`:

```json
{
  "decision": "start",
  "turnId": "inv_...",
  "stats": {"pendingMessages": 0}
}
```

While busy, Agent stores the user entry in its pending FIFO:

```json
{
  "decision": "queue",
  "turnId": null,
  "activeTurnId": "inv_...",
  "stats": {"pendingMessages": 2}
}
```

The queued entry is appended to AgentSession history when steering consumes it
or a successor turn starts. `ask` never classifies, steers, or interrupts.

### `Agent.steer`

Input is a JSON string:

```json
"Also include three cities in the United States."
```

Output is `true` when an active, non-interrupting turn accepted the signal,
otherwise `false`. One signal contains:

```ts
type AgentSessionSteering = {
  queued: ConversationEntry[];
  message: string;
};
```

Agent drains pending entries into `queued`. The current model/tool step is not
cancelled. AgentSession appends those entries, the explicit steering message,
and the steering boundary when the signal is consumed.

### `Agent.interrupt`

Input:

```ts
{
  reason: string;
  message?: string;
}
```

`reason` tells the active turn why it must stop and what finalization should
explain. `message`, when present, is a separate request stored in Agent's FIFO
for the successor turn.

Output is `true` when the first interrupt signal or a replacement message was
accepted. It is `false` when no turn exists or a reason-only repeat arrives
after interruption began.

### `AgentSession.history`

Input:

```ts
{
  fromSequence?: number; // default 1, inclusive
  limit?: number;        // default 50, range 1..100
}
```

Output:

```ts
type HistoryPage = {
  entries: Array<{sequence: number; entry: ConversationEntry}>;
  nextSequence: number;
};
```

Use `nextSequence` as the next inclusive cursor. An empty page leaves the
cursor unchanged.

### Agent notifications

`Agent.notifications` is a void-input shared read returning:

```ts
type AgentNotificationSnapshot = {
  revision: number;
  versions: {
    history: number;
    profile: number;
    approvals: number;
    schedules: number;
  };
};
```

`Agent.watchNotifications` accepts:

```ts
{
  afterRevision: number;
  timeoutSeconds?: number; // default/max 300
}
```

It returns a newer snapshot when any topic changes, or the current snapshot
when the wait window expires. The response is an invalidation watermark, not
the changed data. Compare topic versions and re-read the authoritative handler.

The public client's `follow()` generator combines AgentSession history pages
with this notification wait for history-only consumers.

## Profile API

### `Agent.profile`

Void input. Output:

```ts
type AgentProfile = {
  instructions?: string;
  memories: Array<{key: string; content: string}>;
  guardrails: Array<{id: string; rule: string}>;
};
```

This is the authoritative current snapshot. Active turns retain the snapshot
with which they started.

### `Agent.setInstructions`

Input is `{instructions: string | null}`. A trimmed empty string or `null`
clears the instructions. The handler publishes a `profile` notification and
does not append instruction text to the transcript.

### `Agent.setGuardrails`

Input:

```ts
{guardrails: Array<{id: string; rule: string}>}
```

The list completely replaces policy for future turns. IDs must be unique and
non-empty; an empty list clears guardrails. The handler publishes a `profile`
notification.

## Human approvals

### `Agent.approvals`

Void input. Returns the authoritative pending list:

```ts
type ApprovalRequest = {
  approvalId: string;
  turnId: string;
  question: string;
  guardrailId?: string;
};
```

An omitted `guardrailId` identifies the model-selected `humanApproval` tool.
A present ID identifies a runtime guardrail gate.

### `Agent.resolveApproval`

Input:

```ts
{
  approvalId: string;
  decision: "approved" | "rejected";
  reason?: string;
}
```

Output is `true` only while the request belongs to the active,
non-interrupting turn and the signal is delivered. Agent removes pending state
and publishes an `approvals` notification. AgentSession appends the complete
decision when the waiting turn consumes the signal.

## Scheduled messages

### `Agent.scheduleMessage`

External administration uses `turnId: null`:

```ts
{
  turnId: null;
  schedule: {
    scheduleId: string; // 1..64 chars
    message: string;
    delaySeconds: number; // 1..31,536,000
    repeatEverySeconds: number | null;
    whenBusy?: "queue" | "steer" | "interrupt";
  };
}
```

Omitted `whenBusy` defaults to `queue`; reusing `scheduleId` replaces the
existing timer. Success returns `{accepted: true, replaced, schedule}` with
`nextRunAt` as epoch milliseconds. Tool calls supply their active `turnId`, and
Agent rejects stale or interrupting-turn mutations.

### `Agent.cancelSchedule`

External input is `{turnId: null, scheduleId}`. Success is idempotent and
returns `{accepted: true, cancelled: boolean}`.

### `Agent.schedules`

Void input. Returns the authoritative list of active schedules. Schedule
mutation publishes a `schedules` notification. Only delivery appends a
`schedule` event to the transcript.

## Internal coordination handlers

These are ingress-visible for inspection but are not normal client operations.

### Agent

| Handler | Caller | Purpose |
| --- | --- | --- |
| `fireSchedule` | delayed Agent self-send | Verify timer ID, advance recurrence, and route a due message |
| `notify` | AgentSession | Publish one topic invalidation |
| `subscribeNotifications` | `watchNotifications` | Re-check revision and register a caller awakeable |
| `unsubscribeNotifications` | timed-out/cancelled watch | Remove an abandoned subscription |
| `updateMemory` | `manageMemory` tool | Apply one active-turn memory batch |
| `requestApproval` | tool or policy gate | Register a pending request for the active turn |
| `cancelApproval` | interrupted waiter | Remove abandoned approval state |
| `onTurnEnd` | AgentSession | Retire the matching turn, recover missed steering, and dispatch queued work |

### AgentSession

| Handler | Caller | Purpose |
| --- | --- | --- |
| `doTurn` | Agent one-way send | Execute one complete agent run and append its transcript |
| `compact` | AgentSession self-send | Shared read and model summary of one reserved transcript prefix |
| `applyCompaction` | compactor | Exclusively validate and install a matching checkpoint |

Stale `turnId` values are rejected or ignored as appropriate.

## `AgentSession.doTurn` contract

Input:

```ts
type AgentTurnRequest = {
  instructions?: string;
  memories: Array<{key: string; content: string}>;
  guardrails: Array<{id: string; rule: string}>;
  entries: ConversationEntry[];
};
```

The request does not carry prior history or a summary. The handler loads both
from its own AgentSession state. It returns void to its one-way caller and
reports one outcome to Agent:

```ts
type AgentTurnOutcome =
  | {status: "completed"; turnId: string; response: string; consumedSteering: number}
  | {status: "interrupted"; turnId: string; reason: string; response?: string; consumedSteering: number}
  | {status: "stopped"; turnId: string; cause: "step_limit"; reason: string; response: string; consumedSteering: number}
  | {status: "failed"; turnId: string; error: string; consumedSteering: number};
```

The handler has a one-hour inactivity timeout and fifteen-minute abort timeout.

## Other service handlers

- `ModelGateway.complete`, `evaluateGuardrails`, and `reduceContext` are scoped
  coordination handlers. Runtime code uses their companion functions so the
  `openai` scope and limit keys are always applied.
- `Sandbox.borrow`, `release`, `suspend`, and `destroy` are resource lifecycle
  handlers used by built-in tools and turn cleanup.
- `Evals.all` accepts optional isolation options and a subset of case IDs. See
  [evals.md](evals.md).

## Conversation event-log entries

Every history item has a stable positive `sequence` and one `entry`.

### User entry

```ts
{
  role: "user";
  text: string;
  delivery: "turn" | "queued" | "steer";
}
```

`delivery` records the route assigned when the entry was created. AgentSession
does not later rewrite it. `dispatch` and `steer` events explain activation.

### Assistant entry

```ts
{
  role: "assistant";
  text: string;
  turnId: string;
  status: "completed" | "interrupted" | "stopped" | "failed";
}
```

Assistant entries are terminal run records. External cancellation creates an
interrupt event without a model-authored assistant entry.

### Model-relevant events

| Type | Important fields | Meaning |
| --- | --- | --- |
| `interrupt` | `turnId`, `reason` | Prior-turn interruption boundary |
| `stop` | `turnId`, `cause`, `reason` | Runtime execution-limit boundary |
| `dispatch` | `queuedMessages` | Activates queued requests |
| `steer` | `turnId`, `queuedMessages` | Records a consumed steering batch |
| `approval` | request fields + decision | Delivered human decision |

### Derived status events

| Type | Purpose |
| --- | --- |
| `memory` | Memory keys changed; re-read profile |
| `approval_request` | A pending approval was registered |
| `approval_cancelled` | An abandoned approval was removed |
| `schedule` | A scheduled message fired and how it was routed |
| `progress` | `thinking`, `waiting`, or `finalizing` milestone |
| `activity` | Brief model-authored user-facing activity |
| `tools` | Tool-batch start/finish, IDs, names, summaries, and statuses |

Derived events remain visible to clients but are omitted from future model
context and conversation compaction by the exhaustive
`isDerivedConversationEvent` classifier.

## Transcript ordering

1. AgentSession appends; Agent never writes transcript state.
2. Entries are append-only and sequence numbers never change.
3. An idle turn appends its opening entries before model work.
4. A busy `ask` remains in Agent pending state until steer or successor
   dispatch activates it.
5. Consumed steering appends queued entries, the explicit steer message, then
   the `steer` boundary in one batch.
6. The current turn appends terminal entries before the successor `doTurn` can
   append queued entries and its `dispatch` boundary.
7. Batches passed to the transcript writer remain adjacent.
8. Raw tool arguments/results and private model reasoning are not transcript
   entries.

## Following state correctly

For history alone, use `createAgentClient(...).follow()`. A complete client
that also maintains profile, approvals, and schedules follows this pattern:

```ts
let cursor = 1;
let snapshot = await agent.notifications();

while (!stopped) {
  const page = await agent.history(cursor, 100);
  if (page.entries.length > 0) {
    for (const item of page.entries) consume(item);
    cursor = page.nextSequence;
    continue;
  }

  const next = await agent.watchNotifications(snapshot.revision, 55, {
    idempotencyKey: stableKeyForThisWaitWindow,
  });
  if (next.versions.profile > snapshot.versions.profile) await refreshProfile();
  if (next.versions.approvals > snapshot.versions.approvals) await refreshApprovals();
  if (next.versions.schedules > snapshot.versions.schedules) await refreshSchedules();
  snapshot = next;
}
```

Always drain history again after waking; a history notification can arrive
before or after the corresponding one-way `Agent.notify` is acknowledged.
Retry a transport-failed watch with the same idempotency key so it attaches to
the parked invocation. Generate a new key after a completed wait window.
