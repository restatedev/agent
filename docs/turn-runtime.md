# Turn runtime semantics

This is the behavioral reference for
`packages/libs/core/src/session/service.ts` and
`packages/libs/core/src/session/step.ts`.

One `AgentSession.doTurn` invocation is an **agent run** for one conversation
turn. Its Restate invocation ID is the `turnId`. `agentStep` is one
**agent-loop iteration**, not a conversation turn.

## Ownership

- `Agent` owns the active invocation ID, queued input, profile, approvals,
  private MCP OAuth state and authorization actions, and external-message
  routing.
- `AgentNotifications` owns invalidation revisions and subscriptions;
  `AgentScheduler` owns schedules and durable timers.
- `AgentSession`, keyed by the same `agentId`, owns the append-only transcript
  and compaction checkpoint. Its exclusive `doTurn` handler owns transient
  cross-step execution state.
- At startup, `doTurn` opens history once, appends its activated entries, and
  builds model context from the session summary and uncompacted entries.
- The Agent-supplied profile and minimal MCP credential snapshots
  (`serverId` and `accessToken`) are stable at run start. Profile changes affect
  the next turn; an OAuth completion can additionally deliver a replacement
  minimal credential directly to the waiting run. Refresh tokens and OAuth
  protocol state never enter the Turn.
- `session/step.ts` owns one bounded transition: model call, guardrail gate,
  optional approval wait, and allowed foreground tool batch. It owns no task
  after returning.
- `session/steering.ts` owns the background durable-signal receiver and
  transient FIFO. `session/pending.ts` owns completion tasks that survive
  across steps.
- `session/tools.ts` owns concrete tool definitions, validation, execution,
  completion, and model/transcript projections.
- `Sandbox`, keyed by `agentId`, owns external workspace state across turns.
  One turn borrows lazily and releases on every handled exit.

Built-in tool mechanics execute inside `doTurn`; they are not services merely
for durability. Tools call Agent only for Agent-owned state, AgentScheduler for
durable schedules, Sandbox for serialized resource lifecycle, and independently
deployed dynamic handlers as ordinary durable RPCs.

## Execution shape

- `doTurn` runs the state-machine loop directly. Each loop iteration spawns one
  `agentStep` and settles it against the durable interrupt signal.
- Invocation cancellation rejects a parked operation at the handler boundary.
  The catch path records local cancellation state, one-way releases the
  sandbox, one-way reconciles Agent, and rethrows `CancelledError`.
- Graceful interruption and step-limit exhaustion share one guarded, tool-free
  finalization path over completed work.
- The steering receiver runs alongside a step. Steering is drained only at
  defined boundaries after the step settles.
- All allowed foreground calls in one model response are spawned before the
  step joins the batch.
- The step returns declarative tool outcomes. `doTurn` applies them to the
  cross-step pending registry and appends transcript/model observations.

## Agent-loop iterations

- A run performs at most 50 loop iterations. The runtime does not impose a
  separate limit on the number of tool calls proposed within or across steps.
- Each step receives a copy of the complete live model context accumulated by
  the run.
- Persistent memories are injected once as data before conversation context;
  user instructions are supplied to every agent-model call.
- A normal iteration returns text, tool outcomes, a recoverable model error, or
  a guardrail block.
- Invalid or empty model output becomes corrective user feedback and another
  step within the turn's step bound.
- Provider or orchestration failures stop foreground and pending tasks.
  Interruption and cancellation errors propagate; other failures become a
  structured `failed` outcome.
- Reaching the step bound stops pending work and makes one tool-free final
  call. The outcome is `stopped` with `step_limit`, not a user interruption.

## Guardrails

- A guardrail is `{id, rule}` in the Agent profile; IDs are unique.
- The main agent model does not receive the policy list. It proposes an action,
  then a dedicated policy model evaluates the exact text or complete tool
  batch before publication or execution. A second policy review confirms every
  non-allow candidate before enforcement.
- No guardrails means no policy-model call. With guardrails, decisions are
  `allow`, `deny`, or `require_approval`; policy-model failure fails closed
  under the gateway retry policy.
- The evaluator receives the latest structurally identified user request,
  current-turn evidence after it, approved action scopes, and rejected policy
  IDs. Historical approval prose cannot become a blanket allowlist.
- `deny` adds policy feedback for the next iteration. Repeating the same block
  completes with a deterministic tool-free refusal instead of exhausting the
  step budget.
- `require_approval` registers durable Agent state and waits on a turn-scoped
  signal. Approval resumes the exact proposal; rejection blocks it and
  prevents a loop for that policy in the current request.
- Later proposals are still evaluated. Prior approval is reusable only when
  the evaluator finds the action materially within its recorded scope.
- Steering changes the request and clears approvals, rejections, and repeated
  block tracking before reevaluation.
- Finalization text is also gated. Since shutdown cannot open a new approval,
  `deny` or `require_approval` withholds that final summary.

The evaluator is probabilistic model behavior; enforcement of the returned
decision is deterministic runtime control flow.

## MCP authorization

- Agent-configured MCP servers and their auth type are profile state. OAuth
  credentials are separate private Agent state and never appear in
  `Agent.profile`.
- A new Turn receives the current private credentials with its profile
  snapshot.
- An OAuth server without credentials pauses during tool discovery. A 401 or
  insufficient-scope response during discovery or invocation does the same.
- The Turn registers or joins one pending authorization action per server and
  active Turn, then waits on a named signal. Parallel callers therefore share
  the same browser action.
- The BFF performs OAuth discovery, dynamic client registration, refresh when
  possible, and authorization-code plus PKCE flow. Redirect-round-trip state is
  stored durably by Agent.
- Completion is accepted only for the active, non-interrupting Turn. Agent
  stores the returned credential before signaling the waiter to retry once.
- Interruption, terminal reconciliation, and material MCP server changes clear
  abandoned authorization state.

## Steering

- Repeated resolutions of the named steering signal are a durable FIFO.
- One signal contains `{queued, message}`. Promoted queued entries stay
  distinct from the explicit steering instruction.
- A background receiver drains durable signals into an invocation-local FIFO.
  Its resettable channel announces non-empty state; it is not the durable
  source.
- Steering never cancels a step or existing pending operation.
- If steering arrives during a tool step, tool outcomes are committed first,
  then steering is appended and applied.
- A side-effect-free text or model-error result is discarded as stale if
  steering arrived during its step.
- While waiting for pending work, steering is consumed immediately and starts
  another iteration; pending work continues.
- `consumedSteering` increments once per committed signal. Agent compares it
  with recorded batches to recover any signal that lost a completion race.

When consumed, AgentSession appends the batch's queued entries, the explicit
message with `delivery: "steer"`, and one `steer` event. Agent itself does not
write history.

## Foreground and pending tools

- Tools validate inputs and run only after the entire proposed batch passes
  guardrails.
- Every foreground call in a batch runs concurrently and is joined by the
  step. One tool failure is an observation and does not discard sibling
  results.
- Sandbox file and command calls are one-shot foreground operations, each
  inside its own `restate.run` with cancellation propagation.
- Parallel sandbox calls share one in-flight borrow; dependent operations must
  be proposed in separate loop iterations.
- `manageMemory` atomically mutates at most 32 Agent memory entries and is
  accepted only for the active, non-interrupting `turnId`.
- Schedule tools call AgentScheduler directly. Once an upsert completes, that
  durable side effect survives the turn that created it and is not a pending
  turn operation.
- Assistant tool-call and matching tool-result messages are committed together
  to working model context.
- Foreground outcomes are `succeeded`, `failed`, `pending`, or
  `cancel_requested`.
- Pending completions start as soon as `doTurn` applies the step result and are
  keyed by stable `toolCallId`.
- Cancellation requests target operations that were pending before that step;
  new pending results become addressable after application.
- `cancelOperation` interrupts and joins only its selected task. A completion
  that wins the race stays a completion; unrelated operations continue.
- Text remains only a candidate answer while pending work exists. The run waits
  for completion, steering, or interruption before another step.

## Interruption and stopping

- The interrupt signal asks the active run to end; steering asks it to
  continue with new direction.
- Agent stores an optional replacement user message separately from the
  interruption reason. The replacement belongs to a successor turn.
- During a step, the supervisor interrupts and joins the step task. The step
  joins every foreground tool, retains fulfilled outcomes, and represents
  interrupted calls honestly.
- A pending outcome returned by an interrupted foreground batch is recorded as
  cancelled because its completion task is never started.
- Older pending tasks are stopped and joined. Completion races that already
  won remain completed.
- The run adds retained results and the finalization instruction to working
  context, then makes exactly one tool-free final model call.
- Interruption while waiting after candidate text keeps that text as context
  but does not publish it as the answer by itself.
- If final generation fails, the interrupted outcome carries an explanatory
  fallback.

The step limit uses the same cleanup/finalization mechanics but produces a
`stopped` outcome and a `stop` transcript event. External cancellation skips
model finalization and rethrows cancellation to Restate.

## Transcript and current-state notifications

`doTurn` appends semantic progress (`thinking`, `waiting`, `finalizing`), brief
model-authored activity, and structured tool `started`/`finished` events
directly through its invocation-local history writer. Tool events include IDs,
names, summaries, and final statuses, but not raw arguments or results.

Approval registration/cancellation and delivered decisions are also appended
by the active session. A successful memory tool appends changed keys. External
delivery appends its source and selected route with the delivered input. These
derived events are omitted from future model context and compaction where
appropriate.

Profile setters do not append transcript events; Agent publishes profile
versions to AgentNotifications. Every transcript append one-way publishes the
`history` topic, and AgentScheduler publishes schedule changes. Consumers use
history for ordered conversation data, Agent for `profile` and `approvals`,
AgentScheduler for schedules, and AgentNotifications for invalidation state.

Every `completed`, `interrupted`, `stopped`, or `failed` outcome includes
`consumedSteering`.

## Refactoring constraints

Any rewrite must preserve:

1. AgentSession ownership of transcript state and active-turn execution.
2. One bounded spawned task per `agentStep` loop iteration.
3. FIFO steering and exact reconciliation counts.
4. No cancellation caused by steering.
5. Protocol-complete assistant tool-call and tool-result pairs.
6. Parallel foreground tools and joined cleanup.
7. Immediate start and selective cancellation of pending work.
8. Honest completion-versus-cancellation races.
9. Tool-free interruption finalization using only retained work.
10. Distinct `completed`, `interrupted`, `stopped`, and `failed` outcomes.
11. The 50-step turn bound, without a separate tool-call budget.
12. Stable profile input for the lifetime of a turn.
13. Guardrail evaluation before publishing text or spawning proposed tools.
14. Durable approval before protected work and reevaluation after steering.
15. One initial transcript read followed by direct append-only writes.
