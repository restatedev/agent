# Turn runtime semantics

This is the behavioral reference for
`packages/libs/core/src/session/service.ts` and
`packages/libs/core/src/session/step.ts`.

One `AgentSession.doTurn` invocation is an **agent run** for one conversation
turn. Its Restate invocation ID is the `turnId`. `agentStep` is one
**agent-loop iteration**, not a conversation turn.

## Ownership

- `Agent` owns active work, queued input, profile/memories, approvals,
  schedules, metadata, child bookkeeping, external-message routing and the
  notification revisions/subscriptions.
- `AgentSession`, keyed by the same `agentId`, owns the append-only transcript
  and compaction checkpoint. Its exclusive `doTurn` owns cross-step execution.
- `doTurn` opens history once, appends activated entries and builds model context
  from the summary and uncompacted history.
- Profile and MCP reference snapshots are stable at turn start. Profile edits
  affect the next turn. Environment credentials resolve only inside HTTP
  effects and must never be returned or passed through durable arguments.

- `session/step.ts` owns one bounded transition: model call, guardrail gate,
  optional approval wait, and allowed foreground tool batch. It owns no task
  after returning.
- `session/steering.ts` owns the background durable-signal receiver and
  transient FIFO. `session/pending.ts` owns completion tasks that survive
  across steps.
- `session/tools.ts` owns concrete tool definitions, validation, execution,
  completion, and model/transcript projections.
- `session/program-tool.ts` adapts PTC child calls to that same dispatcher and
  policy gate. `ptc/runtime.ts` supervises their execution inline in `doTurn`;
  `ptc/guest.ts` owns the bounded QuickJS/WebAssembly guest.
- `sandbox/turn.ts` owns the sandbox lifecycle. The ref lives in AgentSession
  state; one turn acquires it lazily and suspends it on every handled exit.

Built-in tool mechanics execute inside `doTurn`; they are not services merely
for durability. Tools call Agent for Agent-owned state (including
schedules) and independently
deployed dynamic handlers as ordinary durable RPCs.

## Execution shape

- `doTurn` runs the state-machine loop directly. Each loop iteration spawns one
  `agentStep` and settles it against the durable interrupt signal.
- Invocation cancellation rejects a parked operation at the handler boundary.
  The catch path records local cancellation state, suspends the sandbox,
  one-way reconciles Agent, and rethrows `CancelledError`.
- Graceful interruption and step-limit exhaustion share one guarded, tool-free
  finalization path over completed work.
- The steering receiver runs alongside a step. Steering is drained only at
  defined boundaries after the step settles. A running program does not hold
  the step open once steering arrives; see [Steering](#steering).
- All allowed foreground calls in one model response are spawned before the
  step joins the batch.
- The step returns declarative tool outcomes. `doTurn` applies them to the
  cross-step pending registry and appends transcript/model observations.

## Agent-loop iterations

- A run performs at most 50 loop iterations. The runtime does not impose a
  separate turn-wide tool-call budget. Each PTC program is independently
  bounded to 128 child calls plus source, output, memory, and computation limits.
- Each step receives a copy of the complete live model context accumulated by
  the run.
- The entire local memory snapshot read by Agent is injected once as data before conversation context;
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
- The `executeProgram` wrapper and source are excluded from that policy check.
  Each emitted child call is gated separately with its concrete name and input
  before execution; PTC does not bypass subtool approvals or authorization.
- No guardrails means no policy-model call. With guardrails, decisions are
  `allow`, `deny`, or `require_approval`; policy-model failure fails closed
  under the model retry policy.
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

## MCP configuration

Agent snapshots the operator's configured server references filtered by tool
grants. Discovery and invocation resolve any environment-backed token inside
the HTTP effect. Metadata changes/removal invalidate later HTTP attempts under
an old snapshot. Missing credentials fail without anonymous fallback or login
waits. Provider errors are sanitized before journaling. See
[MCP configuration](mcp-configuration.md) for rotation, replay and result limits.

## Steering

- Repeated resolutions of the named steering signal are a durable FIFO.
- One signal contains `{queued, message}`. Promoted queued entries stay
  distinct from the explicit steering instruction.
- A background receiver drains durable signals into an invocation-local FIFO.
  Its resettable channel announces non-empty state; it is not the durable
  source.
- Steering never cancels a step or existing pending operation.
- If steering arrives during a tool step, tool outcomes are committed first,
  then steering is appended and applied. Ordinary tools finish first; an
  `executeProgram` call still running is handed to the turn's pending
  operations instead. Its outcome is a pending `{operationId, status:
  "running"}` handle, the program keeps running with its own sleeps and
  approvals, and its return value arrives later as a pending completion. The
  model can let it finish or stop it with `cancelOperation`.
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

- Direct tools validate inputs and run only after their proposed batch passes
  guardrails. PTC child calls pass the same gate individually as they are emitted.
- Every foreground call in a batch runs concurrently and is joined by the
  step. One tool failure is an observation and does not discard sibling
  results.
- Sandbox file and command calls are one-shot foreground operations, each
  inside its own `restate.run` with cancellation propagation.
- Parallel sandbox calls share one in-flight acquisition; dependent operations must
  either be proposed in separate loop iterations or awaited in order inside a
  PTC program.
- `manageMemory` atomically updates this Agent's collection (at most 32 entries).
  Agent accepts only its active, non-interrupting `turnId`.
- Schedule tools persist on the same-key Agent. Once saved, that
  durable side effect survives the turn and is not a pending turn operation.

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

### Model output budgets and recovery

The agent model defaults to 32,000 generated tokens per inference. The core
service's `AGENT_MODEL_MAX_OUTPUT_TOKENS` override accepts integers from 1,024 to
64,000; invalid configuration fails explicitly. This is a ceiling, not a target
answer length. Reasoning tokens share the output budget, so a small cap can be
exhausted before a visible answer exists ([OpenAI documentation](https://developers.openai.com/api/docs/guides/reasoning#controlling-costs)).

On `finishReason: "length"`, the provider adapter rejects the entire generation before
accepting any tool calls and returns a structured `output_limit` error with the
budget used. `callModel` makes at most one recovery generation in
`agent-model-output-recovery`, doubling that recorded budget up to 64,000.
It retains completed tool results, discards the truncated output, and asks for a
concise response/smaller program. At the ceiling no additional attempt is made.
Each attempt has its own journaled run and existing bounded transport retries;
provider SDK retries remain disabled. Recovery derives its budget from the
first journaled result, not a potentially changed environment on replay.
Interrupting the turn aborts an in-flight attempt through the run's signal.

An exhausted recovery ends the Turn as failed; it does not enter the generic
"try again" loop or ask for yet another summary. The existing failure cleanup
stops pending work, suspends the sandbox and records the failure in history.
Other model errors are limited to three consecutive unusable responses.
Completed tools remain in history; recovered proposals still pass the normal
guardrail/approval pipeline. Interruption/step-limit summaries use the same
bounded output recovery with tools disabled and retain final-output guardrails.

Deploy with affected in-flight turns drained/interrupted; changing a replayed
Turn's failure-control flow is not an in-place migration of old journals.

### Programmatic tool calling (PTC)

`executeProgram({source})` is a foreground tool available to the model by
default. It executes an async JavaScript function against the turn's exact tool
catalog, excluding itself. The guest has no direct I/O; all external work goes
through existing tool operations. Only the program's JSON result or program
failure becomes its model observation; child lifecycle and approval events
remain visible in history.

The host drains guest microtasks, registers emitted calls in order, selects one
durable tool completion, and delivers it before draining again. Replay rebuilds
the guest using recorded results and completion ordering, including native
`Promise.all`, `Promise.any`, `Promise.race`, and `Promise.allSettled`.

Within PTC, `sleep` and `humanApproval` are awaited to completion inside the
program instead of returning a pending acknowledgement to the next model round,
so programs can compose them (for example, a retry loop with backoff). If
steering arrives while the program runs, the step hands the program off to the
turn's pending operations and the model reads the steering right away. A race alone does not
cancel losing branches, but program return, failure, or turn interruption stops
and joins outstanding children. Completed side effects are not undone.

See [the PTC guide](tools.md#programmatic-tool-calling-ptc) for examples, limits,
failure handling, and the replay-safe `AGENT_PTC_ENABLED=false` opt-out.

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

Profile setters publish `profile` versions without transcript events. Every
history append sends `Agent.publish("history")` one way; schedule changes
publish inline. Consumers read authoritative history from AgentSession and
context, approvals and schedules from Agent, then use the per-agent
notification versions to invalidate those snapshots.

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
11. The 50-step turn bound and separate per-program PTC limits, without a
    turn-wide tool-call budget.
12. Stable profile input for the lifetime of a turn.
13. Guardrail evaluation before publishing text or executing concrete tools;
    gate PTC children, not their wrapper or source.
14. Durable approval before protected work and reevaluation after steering.
15. One initial transcript read followed by direct append-only writes.
