# Customize control, context and lifecycle

Use this when a request is phrased as behavior (“let me steer a running agent,”
“remember only useful facts,” “stream updates,” “run on a different sandbox”).
First read `docs/agent-guide.md` and the relevant source. The owners below
refer to `packages/libs/core/src/` unless a path starts at the repo root.

## Steer, interrupt, and ask for approval

| Request | Owner and path | Preserve |
| --- | --- | --- |
| Queue, steer, interrupt or deliver external input | `agent/turns.ts`, `agent/active-turn.ts`, `session/steering.ts` | Agent stays responsive; ordered signals reconcile with the active turn and its consumed-steering count. |
| Require approval for a proposed action | `session/step.ts`, `session/approvals.ts`, `agent/approvals.ts` | Guardrail approval gates the exact proposal. A turn-scoped signal resumes it; rejection and steering are handled by the active turn. |
| Let the model ask a human explicitly | `tools/approval.ts`, `session/approvals.ts` | `humanApproval` is a pending tool, distinct from guardrail approval. |
| Cancel an in-flight operation | `tools/operations.ts`, `session/pending.ts` | Stop and join only the operation ID owned by this turn; completed external effects cannot be undone. |
| Delegate to another agent | `agent/sub-agents.ts`, `tools/sub-agents.ts` | Children have separate state and a creation-time profile copy; parent waits for an exact child turn. |

Read `docs/turn-runtime.md` for signal ordering, pending-work races and
interruption. Do not have an exclusive Agent handler wait for a call back into
the same key. A new approval or cancellation path needs an Agent contract,
client/UI operation where exposed, and tests for stale decisions, steering,
and replay.

## Decide which context to change

| Desired behavior | Current mechanism and owner |
| --- | --- |
| Change durable conversation record | Append events through `session/history.ts`; update event schema and projection in `references/agent-handlers.md`. |
| Summarize older finished turns | Background `session/history.ts` + `model/compactor.ts` checkpoint. The public event log remains append-only. |
| Reduce a long active turn's model input | `session/turn-compaction.ts` makes a journaled handoff note before model calls. Configure window/threshold in `agent-config.ts`. |
| Remember facts across turns | `agent/memories.ts` owns a per-agent index and content keys. The turn receives a count; tools search descriptions, then read selected content. |

The two compactions have different lifetimes; neither replaces searchable
memories. Before adding “automatic memory,” decide who writes it, when it is
read, and whether it belongs to one agent or a user account. User-wide memory
requires the app layer in `references/app-layer.md`. See
`docs/architecture.md#context-and-delegation` and
`docs/turn-runtime.md#working-context-compaction`.

## Update the UI or run work later

For live UI updates, publish an invalidation topic in
`agent/notifications.ts`. Add the topic to the notification schema and
client snapshot if new; serve authoritative data from its owner. The browser
captures a revision before reading state, drains sequenced
`AgentSession.history`, then long-polls `Agent.watch({afterRevision})` and
re-reads changed topics. The watch response carries revisions, not content.
Start with `references/agent-handlers.md` and `docs/protocol.md#history-and-notifications`.

For a timer or recurring message, extend `agent/schedules.ts` and the
`createSchedule`/`cancelSchedule` handlers and tools. Current firings deliver
to the **same** agent with an explicit queue/steer/interrupt busy policy.
There is no scheduler object or fresh sub-agent per firing. A user-wide
calendar, cron history, or per-run agent is a new app-layer design; read
`docs/schedules.md` before choosing its owner.

For persistent files or another compute platform, implement the
`SandboxProvider` interface in `sandbox/provider.ts` and keep lifecycle in
`sandbox/turn.ts`. `AgentSession` stores one provider-tagged `SandboxRef`; the
first sandbox tool of a turn acquires it, and turn exit suspends it. There is
no sandbox virtual object, borrow/release lease, or idle TTL in this reference.
For Docker Sandboxes or another provider, decide which storage survives
suspend, how to recover a provision after an uncertain response, and how a
stored ref selects its original provider. Provider operations need retry-safe,
idempotent behavior inside `restate.run`. Read `docs/sandboxes.md` and keep tools on
`context.sandbox.client()`.

## New platform features

Turn- or user-level token-usage budgets and an eval service are possible
extensions. The reference already has a per-call output ceiling and one
truncation-recovery attempt (`AGENT_MODEL_MAX_OUTPUT_TOKENS`; see
`docs/turn-runtime.md#model-output-budgets-and-recovery`). An aggregate budget
would need a scope (turn, user, or sub-agent tree), an owner to reserve and
reconcile usage, and a rule for what parallel children may spend before a
parent sees their cost. For evals, define the scenario inputs, recorded
outcome, and whether scoring belongs in test code or an
independently deployed service. Add a new virtual object only if it needs its
own durable identity and lifecycle. Do not describe these ideas as existing
capabilities.
