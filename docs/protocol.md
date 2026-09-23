# Agent protocol

The schemas in `packages/libs/types/src/index.ts` and declarations in
`services.ts` are authoritative. This guide covers the supported ingress path;
internal coordination handlers remain visible to trusted Restate operators.

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
| `steer` | JSON string | Add input to the active turn; return false if idle |
| `interrupt` | `{reason, message?}` | Interrupt active turn; optionally queue a replacement |
| `deliver` | `{source, sourceId?, message, whenBusy, interruptReason?, coalesce?}` | Route an external message with queue/steer/interrupt policy; `coalesce` drops it while the same `source`/`sourceId` is queued or active |

`ask` returns a discriminated result with `decision` (`start` or `queue`), stats,
and `turnId` for a started turn (`activeTurnId` for queued input). Steering and interruption return whether the active turn accepted
the control. Busy `ask` does not implicitly steer. An interruption reason is
control input to the old turn; a replacement message is separate user input.

```sh
curl localhost:8080/Agent/demo/steer --json '"Also include Paris"'
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

`AgentNotifications.snapshot()` returns `{revision, versions}`; versions has
`history`, `profile`, `approvals`, and `schedules` counters. `watch` accepts
`{afterRevision, timeoutSeconds}` and waits for a new revision or timeout. Keep
the same idempotency key when retrying a single long-poll window; use a new key
after it completes. Notifications invalidate data; they do not carry it.

Capture a notification watermark **before** reading authoritative state, drain
history pages, and then watch. This avoids losing a change between a read and
a subscription. Re-read only changed topics. Profile changes include metadata
and child directory changes. Read schedules from AgentScheduler.

The browser's `snapshot` and `sync` endpoints implement this sequence in
`packages/apps/web/src/server/agent-snapshot.ts`. There is no account-wide feed.

## Context and approvals

| Handler on Agent | Input / result |
| --- | --- |
| `profile` | No input; instructions, guardrails, memories, tools, webSearchEnabled |
| `setInstructions` | `{instructions: string | null}` |
| `setGuardrails` | `{guardrails: [{id, rule}]}` |
| `setTools` | Complete `AgentTools` selection |
| `setWebSearchEnabled` | `{enabled: boolean}` |
| `deleteMemory` | `{key}`; returns whether an entry existed |
| `metadata` | No input; `{name, parentAgentId?}` |
| `children` | No input; direct children with IDs and metadata |
| `toolCatalog` | No input; built-in/dynamic descriptors and configured MCP references |
| `approvals` | No input; pending requests |
| `resolveApproval` | `ApprovalResolutionSchema`; returns whether the request matched |

Profile edits apply to future turns; active turns retain their input snapshot.
`manageMemory` uses the internal `updateMemory` handler, which requires the
active, non-interrupting turn ID and atomically updates agent-local entries.
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

`AgentScheduler.upsert`, `list`, and `cancel` address the same agent key. See
[schedules](schedules.md) for payloads, recurrence and busy policies.

`Agent.retire({})` retires a top-level agent. Child retirement requires matching
parent metadata; it is an internal lifecycle call. Retirement is idempotent,
interrupts active work, drops queued work, retires children/schedules/sandbox,
and refuses new turns. It does not purge retained conversation history.

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
deletion, schedules and retirement. It maps empty-body handlers explicitly.

The Next.js server exposes a limited `/api/agent/{agentId}/{operation}` adapter
that accepts only a loopback Host (or the `APP_PUBLIC_URL` origin) and
same-origin writes. Restate credentials, if configured for connectivity,
stay in its server process. There are no login cookies or account ownership
proofs. Keep both ingress and this local operator UI private.
