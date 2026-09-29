# Customize control, context and lifecycle

Use this when a request is phrased as behavior: "let me approve risky
actions", "remember only useful facts", "run this every morning". First
read `docs/agent-guide.md` and the source of the owner below.

Routing (`ask`, `steer`, `interrupt`, `deliver`), turn end, sub-agents and
live UI updates are in `references/agent-controller.md`.

## Approvals and cancellation

| Request | Owner | Keep |
| --- | --- | --- |
| Require approval for an action the model proposes | `session/guardrails.ts` (`guardAction`), `session/step.ts`, `agent/approvals.ts` | The guardrail approval gates that exact proposal. A signal scoped to the turn resumes it. The active turn handles rejection and steering |
| Let the model ask a person explicitly | `tools/approval.ts`, `session/approvals.ts` | `humanApproval` is a pending tool, separate from guardrail approval |
| Cancel an operation in flight | `tools/operations.ts`, `session/pending.ts` | Stop and join only the operation ID this turn owns. A finished external effect cannot be undone |

Read `docs/turn-runtime.md` for the signal order, the races with pending
work, and interruption. A new approval or cancellation path needs:

- an Agent contract, and a client and UI operation if it is exposed;
- tests for stale decisions, steering and replay.

## Decide which context to change

| Desired behavior | Mechanism and owner |
| --- | --- |
| Change the durable conversation record | Append events through `session/history.ts`. A new event type follows `references/agent-handlers.md#add-a-transcript-event` |
| Summarize older finished turns | A background checkpoint: `session/history.ts` and `model/compactor.ts`. The public event log stays append-only |
| Shrink a long turn's model input | `session/turn-compaction.ts` writes a journaled handoff note before a model call. The window and threshold are in `agent-config.ts` |
| Remember facts across turns | `agent/memories.ts` keeps a per-agent index and one key per memory. The turn gets only the count; tools search the descriptions, then read the chosen content |

The two compactions have different lifetimes, and neither replaces the
searchable memories. Before adding "automatic memory", decide:

- who writes a memory, and when;
- when it is read;
- whether it belongs to one agent or to a user account. User-wide memory
  needs the app layer in `references/app-layer.md`.

See `docs/architecture.md#context-and-delegation` and
`docs/turn-runtime.md#working-context-compaction`.

## Run work later

For a timer or a recurring message, extend `agent/schedules.ts`, the
`createSchedule` and `cancelSchedule` handlers, and their tools.

- A firing delivers to the **same** agent, with an explicit
  `queue`/`steer`/`interrupt` busy policy, and coalesces with itself.
- There is no scheduler object, and no fresh sub-agent per firing.
- A user-wide calendar, a run history or an agent per run is a new
  app-layer design. Read `docs/schedules.md` before choosing its owner.

## Other compute

For a different compute platform, a persistent workspace or a
sandbox-backed tool, read `references/sandboxes.md`. The turn owns when
the sandbox is acquired and released; the provider owns the external
operations.

## Features that do not exist yet

Turn- or user-level token budgets and an eval service are possible
extensions. Do not describe them as existing.

- **Budgets.** Today there is a per-call output limit with one recovery
  attempt after truncation (`AGENT_MODEL_MAX_OUTPUT_TOKENS`; see
  `docs/turn-runtime.md#model-output-budgets-and-recovery`). An aggregate
  budget needs a scope (a turn, a user or a sub-agent tree), an owner that
  reserves and reconciles usage, and a rule for what parallel children may
  spend before the parent sees their cost.
- **Evals.** Define the scenario inputs, the recorded outcome, and whether
  scoring belongs in test code or in an independently deployed service.

Add a new virtual object only if it needs its own durable identity and
lifecycle.
