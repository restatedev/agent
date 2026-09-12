# Agent protocol and conversation event-log contract

This document describes the Restate ingress contract. Public Zod schemas in
`packages/libs/types/src/index.ts` and service descriptors in
`packages/libs/types/src/services.ts` are authoritative.

The API uses `history`, `ConversationEntry`, and `transcript` for the public
**conversation event log**. It is not the complete model/tool trajectory or
Restate execution trace.

## Completed invocation retention

Retention starts after an invocation completes. These settings do not limit
running turns, remove active journals, or expire Virtual Object state such as
profiles, credentials, notification cursors, and conversation history.

| Handlers | Journal | Idempotency/result |
| --- | --- | --- |
| `AgentSession.doTurn` | 1 hour | 1 hour |
| `Agent.ask` | 10 minutes | 10 minutes |
| `ModelGateway.complete`, `evaluateGuardrails` | 1 hour | 1 hour |
| UI reads: profiles, history, ownership, catalogs, approvals, agent/schedule lists | 0 | 0 |
| Agent profile updates: instructions, guardrails, tools, web search | 0 | 0 |
| Agent/user notifications, including snapshot and watch | 0 | 1 hour |
| `Agent.interrupt`, `steer` | 0 | 10 minutes |
| Approval request, cancel, resolve | 0 | 1 hour |
| MCP authorization request, begin, save flow, complete, cancel | 0 | 1 hour |
| Agent creation, initialization, deletion, retirement (including sub-agents) | 0 | 1 hour |
| Sandbox borrow/provision, release, suspend, destroy, retire | 1 hour | 1 hour |
| Schedule upsert, cancel, fire, retire | 0 | 1 hour |

For retried ingress requests, reuse the same idempotency key within the retained
window. Distinct operations (including fresh notification reads) must not reuse
that key. Zero journal retention still permits result retention/deduplication
when idempotency retention is nonzero.

Policies are explicit per handler; other handlers keep their existing settings
or server defaults. In particular, this review does not change compaction,
message delivery/turn-end coordination, memories, login sessions, or connector
configuration mutations. Re-register the service deployment to publish changed
retention settings to Restate. Existing retained records are not explicitly
purged by this code change.

## Addressing and serialization

One logical agent uses the same `agentId` as the key of four public protocol
Virtual Objects:

```text
POST <ingress>/Agent/<agentId>/<handler>
POST <ingress>/AgentSession/<agentId>/<handler>
POST <ingress>/AgentNotifications/<agentId>/<handler>
POST <ingress>/AgentScheduler/<agentId>/<handler>
```

`Agent` is the controller and profile/approval API. `AgentSession` owns history
and executes turns. `AgentNotifications` owns invalidation subscriptions, and
`AgentScheduler` owns schedules and timers. The typed client in
`packages/libs/client/src/index.ts` wraps all four, so normal callers do not
need to manage this split.

All non-void requests use JSON. A void-input handler must receive an empty body
without `content-type`; `{}` with `application/json` is not equivalent. Use an
`idempotency-key` header when retrying one logical request, especially a
long-poll window.

Every handler is ingress-visible for inspection, but only the supported API
below is intended for application clients.

## Supported conversation API

### Public browser workspace sync

The browser uses `POST /api/user/sync` on the authenticated BFF, not direct
Restate ingress. Input:

```ts
{
  revision: number | null; // null for bootstrap
  profileRevision: number | null;
  authorization?: string; // opaque BFF-issued ownership lease; return unchanged
  agents: Array<{
    agentId: string;
    notification?: AgentNotificationSnapshot; // omitted on first opening
    nextSequence: number;
  }>;
}
```

The BFF derives the user identity from its authenticated session cookie. It returns
an opaque `authorization` lease (cached in workspace memory), the user ID,
global/profile revisions, current owned agent IDs, optional changed User profile,
per-agent state deltas (`reset: true` for first load), and changed completion
cursors. A single UserNotifications watch waits up to 25 seconds. Only opened
agents need full data. Deleted agents are evicted; failures retain retry cursors
and return generic per-agent errors without leaking provider details. Never
advance cursors until the response data has been applied. A reset/future cursor
requires a fresh snapshot. Responses are private and non-cacheable by HTTP caches.
Fresh five-minute session and ownership leases validate locally; expiry causes
authoritative Restate revalidation in the same request. Profile notifications
also refresh the owned directory. See [security and revocation semantics](user-identity.md).

Internal `UserNotifications/{userId}` exposes `snapshot`, `watch`, `publish`,
`subscribe`, and `unsubscribe`. Like other ingress handlers, these must remain
behind the trusted BFF boundary. The existing per-agent API below remains usable
by trusted internal clients; the web UI does not open per-agent watches.

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

### `AgentSession.lastTurnSequence`

Void-input shared read returning the sequence number of the latest terminal
assistant response, or `0` before any response. The cursor is indexed in
history metadata when the response is appended, so this read does not load
transcript chunks or wait behind a running turn. Progress, tool activity and
steering do not advance it. Interrupted, stopped and failed final responses
also count as new responses. The typed client exposes `lastTurnSequence()`.

### `AgentNotifications.snapshot`

This is a void-input shared read returning:

```ts
type AgentNotificationSnapshot = {
  revision: number;
  versions: {
    history: number;
    profile: number;
    approvals: number;
    mcpAuth: number;
    schedules: number;
  };
};
```

### `AgentNotifications.watch`

Input:

```ts
{
  afterRevision: number;
  timeoutSeconds?: number; // default/max 300
}
```

It returns a newer snapshot when any topic changes, or the current snapshot
when the wait window expires. The response is an invalidation watermark, not
the changed data. Compare topic versions and re-read the authoritative handler.

The public client's `notifications()` and `watchNotifications()` methods route
to these handlers. Its `follow()` generator combines AgentSession history
pages with the notification wait for history-only consumers.

## Profile API

### `Agent.profile`

Void input. Output:

```ts
type AgentProfile = {
  instructions?: string;
  webSearchEnabled: boolean; // defaults to true
  guardrails: Array<{id: string; rule: string}>;
  tools: {
    builtin: ToolSelection;
    dynamic: ToolSelection;
    mcp: Array<{connectionId: string; tools: ToolSelection}>;
  };};
```

`ToolSelection` is `{mode: "all"}` or `{mode: "selected", names: string[]}`.

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

### `Agent.setWebSearchEnabled`

Input is `{enabled: boolean}`. Saves web search availability for future turns
and publishes a `profile` notification. There is no API key to configure:
the built-in `webSearch` tool uses Tavily keyless access. The browser calls
the same-origin BFF at `POST /api/agent/{agentId}/web-search`; it does not
contact Tavily or Restate directly.

### `Agent.setTools`

Input is the complete `AgentTools` object above. Connection IDs must exist on
the owner User. Saves grants for future turns and publishes `profile`.
Omitted MCP connections default to all tools when authorized on that User;
`{mode:"selected",names:[]}` explicitly opts this agent out. At turn start
`User.snapshot` returns resolved `tools` alongside memories, servers, and
credentials. Agent passes and stores these concrete grants for that turn.
`Agent.toolCatalog` returns selectable built-in names and dynamic
`service/handler` identities.

## User ownership and connections

`User.register` accepts a verified identity from the trusted BFF.
`User.createAgent({agentId,name})` initializes immutable
`Agent.initialize({ownerUserId,name})` ownership and records its directory.
`User.profile` returns identity, agents, and credential-free connection
summaries. The browser cannot choose its User ID or claim an existing Agent.

`User.upsertConnection` accepts
`{id,type:"http",url,protocol:"stateless"|"stateful",auth:{type:"none"|"oauth"|"bearer"}}`.
`removeConnection` and `disconnectConnection` accept `{id}`; material changes
invalidate credentials and generations. `discoverConnection({id})` returns
raw remote tool names/descriptions. Connection changes invalidate owned agents'
profile views. See [user identity](user-identity.md) for BFF endpoints and setup.

## MCP authorization

Agent stores one pending action per connection and active turn; User stores
shared flows, waiters, and encrypted credentials. Agent publishes `mcpAuth`
when its action list changes; the turn waits on its own named signal.

Private User handlers are `requestMcpAuthorization`, `beginAuthorization`,
`cancelMcpAuthorization`, `mcpAuthorizationContext`,
`saveMcpAuthorizationFlow`, `completeMcpAuthorization`, and
`completeMcpBearerAuthorization`. OAuth save/completion includes
`expectedFlow: EncryptedSecret | null` for compare-and-set protection.
The BFF validates Google browser-session ownership, OAuth state and PKCE,
and encrypts secrets before ingress.

User completion stores ciphertext and sends `Agent.resolveMcpAuthorization`
to each attached agent. Agent signals only a matching, active,
non-interrupting turn. Interrupting one agent removes only its waiter.
Removing/disconnecting a connection cancels all its waiters and invalidates
running-turn generations. No refresh tokens or redirect state enter a turn.

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

### `AgentScheduler.upsert`

Input:

```ts
{
  scheduleId: string; // 1..64 chars
  message: string;
  delaySeconds: number; // 1..31,536,000
  repeatEverySeconds: number | null;
  whenBusy: "queue" | "steer" | "interrupt";
}
```

Reusing `scheduleId` replaces the existing timer. Success returns
`{accepted: true, replaced, schedule}` with `nextRunAt` as epoch milliseconds.
The high-level client defaults an omitted `whenBusy` to `queue` before calling
the Restate handler.

Schedule tools call AgentScheduler directly. Once `upsert` completes, the
schedule is a durable side effect independent of the originating turn; a
later interruption does not roll it back.

### `AgentScheduler.cancel`

Input is `{scheduleId}`. Success is idempotent and returns
`{accepted: true, cancelled: boolean}`.

### `AgentScheduler.list`

Void input. Returns the authoritative list of active schedules. Schedule
mutation publishes a `schedules` notification. Delivery appends a generic
`delivery` event with `source: "schedule"` to the transcript.

### `Agent.deliver`

External producers route messages through:

```ts
{
  source: string;
  sourceId?: string;
  message: string;
  whenBusy: "queue" | "steer" | "interrupt";
  interruptReason?: string;
}
```

An idle Agent starts a turn. A busy Agent queues, steers, or interrupts. An
already-interrupting Agent always queues. The handler is source-agnostic;
AgentScheduler is currently its only built-in producer. The typed client
exposes the same contract as `agent.deliver(...)`.

## Internal coordination handlers

These are ingress-visible for inspection but are not normal client operations.

### Agent

| Handler | Caller | Purpose |
| --- | --- | --- |
| `updateMemory` | `manageMemory` tool | Validate active turn and forward a shared memory batch to its owning User |
| `createSubAgent` | `createSubAgent` tool | Validate active turn, inherit/restrict configuration, and register a child through its owning User |
| `listSubAgents` | `listSubAgents` tool | Validate active turn and list only this agent's direct children through User |
| `deleteSubAgent` | `deleteSubAgent` tool | Validate active turn and ask User to delete a direct child's subtree |
| `requestApproval` | tool or policy gate | Register a pending request for the active turn |
| `cancelApproval` | interrupted waiter | Remove abandoned approval state |
| `requestMcpAuthorization` | MCP discovery or tool invocation | Register or coalesce a pending OAuth/bearer action |
| `cancelMcpAuthorization` | interrupted MCP waiter | Remove an abandoned Agent action and its User waiter |
| `mcpAuthorizationContext` | trusted BFF | Read private server, OAuth, and redirect state |
| `saveMcpAuthorizationFlow` | trusted BFF | Persist discovery, client registration, state, and PKCE material |
| `completeMcpAuthorization` | trusted BFF | Store private OAuth state and signal the waiting Turn with an access token |
| `completeMcpBearerAuthorization` | trusted BFF | Store a private bearer token and signal the waiting Turn with it |
| `onTurnEnd` | AgentSession | Retire the matching turn, recover missed steering, and dispatch queued work |

### AgentNotifications

| Handler | Caller | Purpose |
| --- | --- | --- |
| `publish` | AgentSession, Agent, or AgentScheduler | Advance one topic watermark and wake subscribers |
| `subscribe` | `watch` | Re-check the revision and register a caller awakeable |
| `unsubscribe` | timed-out/cancelled `watch` | Remove an abandoned subscription |

### AgentScheduler

| Handler | Caller | Purpose |
| --- | --- | --- |
| `fire` | delayed AgentScheduler self-send | Verify timer ID, advance recurrence, and call `Agent.deliver` |

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
  memories: Array<{key: string; content: string}>; // full User snapshot, fetched by Agent
  guardrails: Array<{id: string; rule: string}>;
  ownerUserId: string;
  tools: AgentTools;
  webSearchEnabled: boolean;
  mcpServers: Array<McpServer & {revision: number}>;
  mcpCredentials: Array<{serverId: string; encryptedToken: string}>; // private Agent-to-Turn field
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

- `ModelGateway.complete` and `evaluateGuardrails` are scoped coordination
  handlers. Runtime code uses their companion functions so the `openai` scope
  and limit keys are always applied.
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
| `memory` | Shared memory keys changed; re-read User profile |
| `approval_request` | A pending approval was registered |
| `approval_cancelled` | An abandoned approval was removed |
| `delivery` | An external source delivered a message and how it was routed |
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
that also maintains profile, approvals, MCP authorization actions, and
schedules follows this pattern:

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
  if (next.versions.mcpAuth > snapshot.versions.mcpAuth) await refreshMcpAuthorizations();
  if (next.versions.schedules > snapshot.versions.schedules) await refreshSchedules();
  snapshot = next;
}
```

Always drain history again after waking; a history notification can arrive
before or after the corresponding one-way `AgentNotifications.publish` is
acknowledged.
Retry a transport-failed watch with the same idempotency key so it attaches to
the parked invocation. Generate a new key after a completed wait window.
