# Agent protocol

The schemas in `packages/libs/types/src/index.ts` and declarations in
`services.ts` are authoritative. This guide covers the supported ingress path.
Internal coordination handlers (`onTurnEnd`, approval registration, sub-agent
coordination, notifications plumbing, and every `AgentSession` handler except
`history`) are marked `ingressPrivate`, so ingress rejects them; the Restate
admin API still shows them to operators. This needs restate-server 1.4 or
newer.

## Addressing and creation

All conversation objects use the same `agentId`. Send a message to start:

```sh
curl localhost:8080/Agent/demo/ask --json '{"message":"Hello"}'
```

No registration or explicit creation is required. Optional
`Agent.initialize({name, profile?})` supplies initial metadata/configuration
before first use. `parentAgentId` is reserved for runtime-created children.
The fallback display name is the agent ID. Retired IDs cannot be restarted.

## Conversation control

| Handler on `Agent/{agentId}` | Input | Effect |
| --- | --- | --- |
| `ask` | `{message}` | Start while idle; enqueue FIFO while busy |
| `steer` | `{message}` | Add input to the active turn; return false if idle |
| `interrupt` | `{reason, message?}` | Interrupt active turn; optionally queue a replacement |
| `deliver` | `{source, sourceId?, message, whenBusy, interruptReason?, coalesce?}` | Route an external message with queue/steer/interrupt policy; `coalesce` drops it while the same `source`/`sourceId` is queued or active |

A busy agent holds at most 32 queued user messages, and one turn accepts at
most 32 steering messages. Past either limit, `ask`, `steer`, `interrupt`
with a replacement, and `deliver` fail with HTTP 429.

`ask` returns a discriminated result with `decision` (`start` or `queue`), stats,
and `turnId` for a started turn (`activeTurnId` for queued input). Steering and interruption return whether the active turn accepted
the control. Busy `ask` does not implicitly steer. An interruption reason is
control input to the old turn; a replacement message is separate user input.

```sh
curl localhost:8080/Agent/demo/steer --json '{"message":"Also include Paris"}'
curl localhost:8080/Agent/demo/interrupt \
  --json '{"reason":"Change of plan","message":"Only check Berlin"}'
```

A child conversation rejects direct ask, steering, external delivery,
replacement messages, and direct profile edits. Parent delegation starts its
turns. The local UI permits inspection, interruption without replacement, and
approval resolution.

## History and notifications

`AgentSession.history({fromSequence, limit})` returns ordered sequenced entries
and `nextSequence`. Begin at 1 and use the returned cursor to paginate. The
public log is append-only; compaction affects model context, not stored entries.

`Agent.notifications()` returns `{revision, versions}`; versions has
`history`, `profile`, `approvals`, and `schedules` counters. `watch` accepts
`{afterRevision, timeoutSeconds}` and waits for a new revision or timeout. Keep
the same idempotency key when retrying a single long-poll window; use a new key
after it completes. Notifications invalidate data; they do not carry it.

Capture a notification watermark **before** reading authoritative state, drain
history pages, and then watch. This avoids losing a change between a read and
a subscription. Re-read only changed topics. Profile changes include metadata
and child directory changes.

The browser's `snapshot` and `sync` endpoints implement this sequence in
`packages/apps/web/src/server/agent-snapshot.ts`. There is no account-wide feed.

## Context and approvals

| Handler on Agent | Input / result |
| --- | --- |
| `profile` | No input; instructions, guardrails, memory index, tools, webSearchEnabled |
| `updateProfile` | Any of `{instructions: string \| null, guardrails: [{id, rule}], tools: AgentTools, webSearchEnabled: boolean}`; each given field is replaced whole |
| `searchMemories` | `{query}`; up to 10 matching `{id, description}` index entries, no content |
| `readMemories` | `{ids}`; full memories for known IDs, unknown IDs left out |
| `deleteMemory` | `{id}`; returns whether the memory existed |
| `metadata` | No input; `{name, parentAgentId?}` |
| `children` | No input; direct children with IDs and metadata |
| `toolCatalog` | No input; built-in/dynamic descriptors and configured MCP references |
| `approvals` | No input; pending requests |
| `resolveApproval` | `ApprovalResolutionSchema`; returns whether the request matched |

Profile edits apply to future turns; active turns retain their input snapshot.
`manageMemory` uses the internal `updateMemory` handler, which requires the
active, non-interrupting turn ID and applies a batch of creates, updates and
deletes atomically. A batch naming an unknown ID changes nothing. Created
memories get fresh IDs, which are never reused.
Approval IDs and turn IDs correlate decisions to the exact waiting proposal.
Guardrail approval is distinct from the explicit `humanApproval` tool.

Void-input handlers require **no body and no content-type**. For example:

```sh
curl -X POST localhost:8080/Agent/demo/profile
curl -X POST localhost:8080/Agent/demo/approvals
```

## Delegation, schedules and retirement

The model uses `createSubAgent`, `messageSubAgent`, `listSubAgents` and
`deleteSubAgent`. Controller coordination checks the active parent turn and
its allowed tools, while the session waits for the exact child invocation.
Children copy creation-time context, retain separate state, and cannot broaden
permissions. Parent cleanup targets only its recorded child turn.

`Agent.createSchedule`, `schedules`, and `cancelSchedule` manage schedules. See
[schedules](schedules.md) for payloads, recurrence and busy policies.

`Agent.retire({})` retires a top-level agent. Child retirement requires matching
parent metadata; it is an internal lifecycle call. Retirement is idempotent,
interrupts active work, drops queued work and pending approvals, clears the
profile and memories, retires children/schedules/sandbox, and refuses new
turns. It does not purge retained conversation history.

## Typed clients and local UI

```ts
import {createAgentClient} from "@restate-agents/client";

const agent = createAgentClient({
  ingressUrl: "http://localhost:8080",
  agentId: "demo",
});
await agent.ask("What is the weather in Berlin?");
for await (const {entry} of agent.follow()) {
  if (entry.role === "assistant") console.log(entry.text);
}
```

The client also exposes profile setters, approvals, metadata, children, memory
search, reads and deletion, schedules and retirement. It maps empty-body handlers explicitly.

The Next.js server exposes a limited `/api/agent/{agentId}/{operation}`
adapter whose operation names match the Agent handlers. `GET` serves
`snapshot` and `sync` (batched reads for one page render and its long poll),
`profile` and `toolCatalog`. `POST` serves `ask`, `steer`, `interrupt`,
`updateProfile`, `deleteMemory`, `cancelSchedule` and `resolveApproval`, each
with a JSON body validated against the shared schema. Both tables live in
`packages/apps/web/src/server/operations.ts`. `POST /api/ag-ui` serves the
same conversation to AG-UI clients; see [AG-UI](ag-ui.md).

Every request, reads included, must carry a loopback Host, or, when
`APP_PUBLIC_URL` is set, that URL's host (or one listed in `APP_ALLOWED_HOSTS`
for proxies that rewrite it); this is the DNS-rebinding defence. Writes must
also carry a same-origin `Origin` header. Restate credentials, if configured
for connectivity, stay in its server process. There are no login cookies or
account ownership proofs. Keep both ingress and this local operator UI
private.
