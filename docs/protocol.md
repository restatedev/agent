# Agent protocol and conversation event-log contract

This document describes the HTTP/Restate-facing contract. The Zod schemas in
`agent.ts` and `types.ts` are authoritative.

The API and code retain the names `history`, `ConversationEntry`, and
`transcript`. In stricter agent terminology this is the public **conversation
event log**, not the complete agent trajectory or Restate execution trace.

## Addressing and serialization

The deterministic `Agent` session controller is a Virtual Object keyed by
`agentId`:

```text
POST <ingress>/Agent/<agentId>/<handler>
```

All non-void requests use JSON. A void-input handler must receive an empty body
without `content-type`; sending `{}` with `application/json` is not equivalent.

Use an `idempotency-key` header when retrying one logical client operation.
The typed reference client in `packages/libs/example/src/client.ts` implements
the supported conversation API and the correct history-follow loop.

Every handler is ingress-visible in this reference project so the complete
protocol can be inspected. Only the handlers in the next section are intended
as the normal client API.

## Supported external Agent API

### `ask`

Input:

```ts
{ message?: string }
```

An omitted message uses the demo default. While idle, Agent appends the message
and starts a Turn:

```json
{
  "decision": "start",
  "turnId": "inv_...",
  "stats": {"pendingMessages": 0}
}
```

While busy, Agent appends and queues it for a future Turn:

```json
{
  "decision": "queue",
  "turnId": null,
  "activeTurnId": "inv_...",
  "stats": {"pendingMessages": 2}
}
```

`ask` never steers or interrupts active work. Clients select those operations
explicitly.

### `steer`

Input is a JSON string:

```json
"Also include three cities in the United States."
```

Output is `true` when the message was signalled to an active,
non-interrupting Turn, otherwise `false`.

Steer drains already queued messages into the same structured signal:

```ts
type SteeringSignal = {
  queued: string[];
  message: string;
};
```

The current model/tool step is not cancelled.

### `interrupt`

Input:

```ts
{
  reason: string;
  message?: string;
}
```

`reason` tells the old Turn why it must stop and what its final summary should
explain. `message`, when present, is a separate user request appended and
queued for a new Turn.

Output is `true` when the first interruption signal or a replacement message
was accepted. It is `false` when no Turn exists or a reason-only repeat arrives
after interruption already began.

### `history`

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
  entries: Array<{
    sequence: number;
    entry: ConversationEntry;
  }>;
  nextSequence: number;
};
```

Use `nextSequence` as the next inclusive cursor. An empty page leaves the
cursor unchanged.

### `watchHistory`

Input:

```ts
{
  fromSequence: number;
  timeoutSeconds?: number; // default/max 300
}
```

Output is:

- `true` when that sequence is ready to read; or
- `false` when the wait window elapsed.

The client must always call `history` again after either result. The watch is a
notification, not a data channel. A complete consumer loop is implemented by
`createAgentClient(...).follow()`.

### `profile`

Void input. Output:

```ts
type AgentProfile = {
  instructions?: string;
  memories: Array<{key: string; content: string}>;
  guardrails: Array<{id: string; rule: string}>;
};
```

This is the authoritative current snapshot. Running Turns keep the snapshot
with which they started.

### `setInstructions`

Input:

```ts
{ instructions: string | null }
```

The string is trimmed and replaces persistent user instructions. `null` or an
empty trimmed string clears them. Output is void.

### `setGuardrails`

Input:

```ts
{
  guardrails: Array<{
    id: string;
    rule: string;
  }>;
}
```

The list completely replaces future-Turn policy. IDs must be unique and
non-empty. An empty list clears guardrails. Output is void.

### `approvals`

Void input. Returns current pending requests:

```ts
type ApprovalRequest = {
  approvalId: string;
  turnId: string;
  question: string;
  guardrailId?: string;
};
```

An omitted `guardrailId` means the model explicitly called the
`humanApproval` tool. A present ID means the runtime guardrail gate opened the
request.

### `resolveApproval`

Input:

```ts
{
  approvalId: string;
  decision: "approved" | "rejected";
  reason?: string;
}
```

Output is `true` only if the approval still belongs to the active,
non-interrupting Turn and its signal was delivered. Resolution removes pending
state and appends the complete decision to history.

### `scheduleMessage`

Administrative input uses `turnId: null`:

```ts
{
  turnId: null;
  schedule: {
    scheduleId: string;              // 1..64 chars
    message: string;
    delaySeconds: number;            // 1..31,536,000
    repeatEverySeconds: number | null;
    whenBusy?: "queue" | "steer" | "interrupt";
  };
}
```

Omitted `whenBusy` defaults to `queue`. Reusing `scheduleId` replaces the
existing timer.

Success:

```ts
{
  accepted: true;
  replaced: boolean;
  schedule: {
    scheduleId: string;
    message: string;
    repeatEverySeconds: number | null;
    whenBusy: "queue" | "steer" | "interrupt";
    nextRunAt: number; // epoch milliseconds
  };
}
```

The tool-facing path supplies the active `turnId`; Agent rejects a stale or
interrupting Turn mutation.

### `cancelSchedule`

Input:

```ts
{ turnId: null; scheduleId: string }
```

Success is idempotent:

```ts
{ accepted: true; cancelled: boolean }
```

### `schedules`

Void input. Returns the authoritative list of active scheduled messages using
the visible schedule shape above.

## Internal Agent coordination handlers

These are ingress-visible for inspectability but are not normal client
operations:

| Handler | Caller | Purpose |
| --- | --- | --- |
| `fireSchedule` | delayed Agent self-send | Verify timer ID, advance recurrence, and route due message |
| `registerHistoryWatcher` | `watchHistory` | Exclusive cursor re-check and awakeable registration |
| `unregisterHistoryWatcher` | timed-out watch | Idempotent watcher cleanup |
| `updateMemory` | `manageMemory` tool | Apply one active-Turn memory batch |
| `reportProgress` | Turn | Append semantic progress for the current Turn |
| `reportExecution` | Turn | Append activity and tool lifecycle reports |
| `requestApproval` | tool or policy gate | Register a pending active-Turn request |
| `cancelApproval` | interrupted waiter | Clean abandoned approval state |
| `onTurnEnd` | Turn | Reconcile the single terminal outcome |
| `compact` | Agent self-send | Shared history read and summary model call |
| `applyCompaction` | compactor | Exclusive checkpoint validation/application |

Stale Turn IDs are ignored or rejected as appropriate. These handlers must not
be used to bypass the public routing contract.

## Other service handlers

### Turn

`Turn/run` starts one durable agent run and accepts:

```ts
type TurnRequest = {
  agentId: string;
  instructions?: string;
  memories: Array<{key: string; content: string}>;
  guardrails: Array<{id: string; rule: string}>;
  summary?: string;
  history: ConversationEntry[];
};
```

It returns void to its one-way caller and reports exactly one `TurnOutcome` to
Agent:

```ts
type TurnOutcome =
  | {
      status: "completed";
      turnId: string;
      response: string;
      consumedSteering: number;
    }
  | {
      status: "interrupted";
      turnId: string;
      reason: string;
      response?: string;
      consumedSteering: number;
    }
  | {
      status: "stopped";
      turnId: string;
      cause: "step_limit" | "tool_limit";
      reason: string;
      response: string;
      consumedSteering: number;
    }
  | {
      status: "failed";
      turnId: string;
      error: string;
      consumedSteering: number;
    };
```

The Turn handler has a one-hour inactivity timeout and fifteen-minute abort
timeout.

### ModelGateway

`complete`, `evaluateGuardrails`, and `reduceContext` are scoped coordination
handlers. Their Zod contracts live in `model.ts`. Application code should call
the `callModel`, `callGuardrailModel`, and `callContextReducer` companions so
the `openai` scope and limit keys are applied.

### Sandbox

`borrow`, `release`, `suspend`, and `destroy` are lifecycle handlers. Normal
clients do not call them; sandbox tools acquire and release through Turn.

### Evals

`Evals/all` accepts optional `runId`, `attempt`, `timeoutSeconds`, and a subset
of case IDs. See [evals.md](evals.md).

## Conversation event-log entry contract

Every public history item has a stable `sequence` wrapper and one `entry`.

### User entry

```ts
{
  role: "user";
  text: string;
  delivery: "turn" | "queued" | "steer";
}
```

`delivery` describes how Agent originally accepted the message. It never
changes. Later `steer` or `dispatch` events describe activation.

### Assistant entry

```ts
{
  role: "assistant";
  text: string;
  turnId: string;
  status: "completed" | "interrupted" | "stopped" | "failed";
}
```

Assistant entries are terminal agent-run records. An externally cancelled Turn
may have an interrupt event without an assistant entry.

### Control and semantic events

| Type | Important fields | Model context? |
| --- | --- | --- |
| `interrupt` | `turnId`, `reason` | Yes, as a prior-Turn boundary |
| `stop` | `turnId`, `cause`, `reason` | Yes, as a runtime-limit boundary |
| `dispatch` | `queuedMessages` | Yes, activates queued requests |
| `steer` | `turnId`, `queuedMessages` | Yes, records signal target |
| `approval` | request fields + decision | Yes, completed human decision |

### Derived status events

| Type | Purpose |
| --- | --- |
| `profile` | Instructions/guardrails changed; re-read profile |
| `memory` | Memory keys changed; re-read profile |
| `approval_request` | Add one pending approval |
| `approval_cancelled` | Remove abandoned approval |
| `schedule` | Schedule state changed or fired; re-read schedules |
| `progress` | `thinking`, `waiting`, or `finalizing` milestone |
| `activity` | Brief model-authored, user-facing step activity |
| `tools` | Tool batch `started`/`finished`, IDs, names, statuses |

Derived events are deliberately omitted from future model context and
conversation compaction. `isDerivedConversationEvent` is the one exhaustive
classification function used by both.

## Transcript ordering rules

1. Entries are appended in the natural order Agent handlers observe them.
2. Existing entries are never changed to reflect later routing.
3. A queued message therefore appears when accepted, not when dispatched.
4. An interrupt carrying a replacement appends the replacement before the
   interrupt boundary.
5. `onTurnEnd` appends the old terminal result before the dispatch boundary
   that starts queued work.
6. Batches passed to `history.append` stay adjacent.
7. Tool arguments/results and raw model reasoning remain in invocation
   observability, not the user-facing transcript.

## Following history correctly

Pseudocode:

```ts
let cursor = 1;

while (!stopped) {
  const page = await agent.history(cursor, 100);
  if (page.entries.length > 0) {
    for (const item of page.entries) consume(item);
    cursor = page.nextSequence;
    continue;
  }

  await agent.watchHistory(cursor, 55, {
    idempotencyKey: stableKeyForThisWaitWindow,
  });
}
```

Retry a transport-failed watch with the same idempotency key so the request
attaches to its existing invocation instead of stacking another waiter. After
a completed window, generate a new key.

`createTranscriptProjection` demonstrates how one cursor stream can maintain
pending approvals exactly and emit invalidation signals for profile and
schedule snapshots.
