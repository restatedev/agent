# Turn runtime semantics

This is the behavioral reference for
`packages/libs/core/src/session/service.ts` and the modules it composes. The
model/tool loop itself is the agent SDK, `@restate-agents/core` (vendored under
`vendor/`); its `agent-run.ts`, `run-tools.ts` and `tool-executor.ts` are the
source of truth for loop mechanics.

One `AgentSession.doTurn` invocation is an **agent run** for one conversation
turn. Its Restate invocation ID is the `turnId`. A **step** is one planning
model call of that run, not a conversation turn.

## Ownership

- `Agent` owns active work, queued input, profile/memories, approvals,
  schedules, metadata, child bookkeeping, external-message routing and the
  notification revisions/subscriptions.
- `AgentSession`, keyed by the same `agentId`, owns the append-only transcript
  and compaction checkpoint. Its exclusive `doTurn` owns cross-step execution.
- `doTurn` opens history once, appends activated entries and builds model context
  from the summary and uncompacted history (`session/context.ts`).
- Profile and MCP reference snapshots are stable at turn start. Profile edits
  affect the next turn. Environment credentials are resolved right before each
  HTTP effect, used only inside it, and never returned or passed through
  durable arguments.

- The SDK's `agent(...).run(...)` owns the loop: model steps, parallel tool
  batches, background tools, steering, interruption and tool-free
  finalization. `session/service.ts` configures it and maps its `RunResult` to
  the turn outcome.
- `session/progress.ts` is the run's steering source and progress handler; it
  writes the run's events to the transcript.
- `session/guardrails.ts` supplies the run's `beforeStep`, `beforeTool` and
  `afterRun` policies.
- `session/turn-tools.ts` builds the turn's permitted tool catalog; concrete
  built-ins live in `session/tools/`, and `executeProgram` is the SDK's
  `programTool`.
- `sandbox/turn.ts` owns the sandbox lifecycle. The ref lives in AgentSession
  state; one turn acquires it lazily and suspends it on every handled exit.

Built-in tool mechanics execute inside `doTurn`; they are not services merely
for durability. Tools call Agent for Agent-owned state (including
schedules) and independently
deployed dynamic handlers as ordinary durable RPCs.

## Execution shape

- `doTurn` makes one SDK run with the turn's context, catalog, prior messages,
  steering source and the durable interrupt signal as controls.
- Every exit reports to `Agent.onTurnEnd`. Invocation cancellation rejects a
  parked operation at the handler boundary; `abandonTurn` first reports the
  interruption one way, then appends it to history, releases the MCP sessions
  and sandbox, and rethrows `CancelledError`. Cancellation during cleanup or
  during the normal `onTurnEnd` call takes the same path, and a cleanup failure
  becomes a failed outcome, so every exit clears the Agent's active turn.
- Graceful interruption and the step limit share one guarded, tool-free
  finalization path over completed work.
- Steering is raced against every wait of the run. It is recorded the moment it
  arrives; see [Steering](#steering).
- All foreground calls in one model response are started together, and the
  tool phase lasts until each has settled.

## Agent-loop iterations

- A run performs at most 50 steps. Its tool-call bound (50 × 128, counting
  calls made by programs) exists only so that it trips after both steps and
  per-program limits are exhausted. Each PTC program is independently bounded
  to 128 child calls plus source, output, memory, and computation limits.
- Each step sends the run's complete working context; the SDK keeps each tool
  batch's results directly after its assistant call.
- The entire local memory snapshot read by Agent is injected once as data before conversation context;
  user instructions are supplied to every agent-model call.
- A step returns final text or a tool batch. A final answer is accepted only
  when no background work is outstanding.
- Invalid, empty or incomplete model output (for example, a response cut off by
  the 32,000-token output limit) is a terminal model protocol error and fails
  the turn; there is no corrective retry or recovery generation.
- Provider or orchestration failures stop foreground and background tasks.
  Interruption and cancellation errors propagate; other failures become a
  structured `failed` outcome.
- Reaching the step bound stops background work and makes one tool-free final
  call. The outcome is `stopped` with `step_limit`, not a user interruption.
  The tool-call bound produces the same cause with a different reason.

## Guardrails

- A guardrail is `{id, rule}` in the Agent profile; IDs are unique.
- The main agent model does not receive the policy list. It proposes an action,
  then a dedicated structured-output policy agent evaluates each concrete tool
  call before it runs, and the final text before it is published. A second,
  independent review agent must confirm every non-allow candidate before
  enforcement; an unconfirmed one becomes `allow`.
- The `executeProgram` wrapper and source are excluded from that policy check.
  Each emitted child call is gated separately with its concrete name and input
  before execution; PTC does not bypass subtool approvals or authorization.
- No guardrails means no policy-model call. With guardrails, decisions are
  `allow`, `deny`, or `require_approval`. A policy run that does not complete
  fails closed: a tool call is blocked with a policy-check failure, and a failed
  check of the final text fails the turn.
- The evaluator receives the persistent instructions, the remaining guardrails,
  the turn's messages as of its last model step, approved action scopes,
  rejected policy IDs and the exact proposed action. Historical approval prose
  cannot become a blanket allowlist.
- A denied call returns a denial message to the model, which may choose another
  action. There is no deterministic refusal after a repeated block.
- `require_approval` asks a human through `askHuman`: Agent registers the
  request and the turn waits on its approval signal. Once approved, that
  guardrail drops out and the remaining ones are checked again; a rejection
  blocks the action and turns later approval requests for that policy into
  denials in the current request.
- Later proposals are still evaluated. Prior approval is reusable only when
  the evaluator finds the action materially within its recorded scope.
- Steering changes the request and clears approvals and rejections before
  reevaluation.
- Final text is also gated, and may ask a human too. A denied final answer is
  replaced by a refusal; a denied interruption or step-limit summary is
  withheld.

The evaluator is probabilistic model behavior; enforcement of the returned
decision is deterministic runtime control flow.

## MCP configuration

Agent snapshots the operator's configured server references filtered by tool
grants. Discovery and invocation resolve any environment-backed token right
before the HTTP effect that uses it. Metadata changes/removal invalidate later
HTTP attempts under an old snapshot. Missing credentials fail without
anonymous fallback or login waits; a server that fails discovery is reported
unavailable to the model instead of failing the turn. A credential the server
echoes back is redacted before journaling. See
[MCP configuration](mcp-configuration.md) for rotation, replay and result limits.

## Steering

- Repeated resolutions of the named steering signal are a durable FIFO.
- One signal contains `{queued, message}`. Promoted queued entries stay
  distinct from the explicit steering instruction; the signal rides through the
  SDK as the steering update's `data`.
- Steering never cancels a tool call or background operation.
- If steering arrives during a model request or the review of a final answer,
  that work is discarded and the next step plans with the steering in context.
  Each such re-plan counts as a step.
- If steering arrives during a tool phase, it is added to context and ordinary
  tools keep running until the batch settles. An `executeProgram` call still
  running is moved to background work instead: it gets a pending result, keeps
  running with its own sleeps and approvals, and its return value arrives
  later as a background result. The model can let it finish or stop it with
  `cancelOperation`.
- While waiting for background work, steering is consumed immediately and
  starts another step; background work continues.
- `consumedSteering` increments once per accepted signal, as each lands. Agent
  compares it with recorded batches to recover any signal that lost a
  completion race.

When consumed, AgentSession appends the batch's queued entries, the explicit
message with `delivery: "steer"`, and one `steer` event. Agent itself does not
write history.

## Foreground and background tools

- Tool inputs are validated against their schema before the call runs. Direct
  calls and PTC child calls pass the guardrail gate individually.
- Every foreground call in a batch runs concurrently. One tool failure is an
  observation and does not discard sibling results.
- Sandbox file and command calls are one-shot foreground operations, each
  inside its own `restate.run` with cancellation propagation.
- Parallel sandbox calls share one in-flight acquisition; dependent operations must
  either be proposed in separate loop iterations or awaited in order inside a
  PTC program.
- `manageMemory` atomically updates this Agent's collection (at most 32 entries).
  Agent accepts only its active, non-interrupting `turnId`.
- Schedule tools persist on the same-key Agent. Once saved, that
  durable side effect survives the turn and is not a background operation.

- Assistant tool-call and matching tool-result messages stay together in the
  working model context.
- Tool results are `success`, `error`, `denied`, `cancelled`, or `pending`
  (a background call's acknowledgement). A result over 128,000 characters is an
  error, not truncated.
- Background calls (`sleep`, `humanApproval`, and handed-off programs) start
  with their batch and are keyed by stable tool-call ID.
- A background result reaches the model as a user-role `agent-runtime`
  message, in completion order. One that arrives during a model request
  invalidates that request's response, so the model sees the result first.
- `cancelOperation` interrupts and joins only its selected task. A completion
  that wins the race stays a completion; unrelated operations continue.
- Text remains only a candidate answer while background work exists. The run
  waits for a result, steering, or interruption before another step.

### Model calls and output limits

Each model call is one journaled `restate.run` made through the SDK's
`aiModel` adapter (`model/models.ts`), retried by Restate up to four attempts
with exponential backoff; provider SDK retries are disabled. A non-retryable
provider error fails the turn. The agent model may generate up to 32,000
tokens per call; this is a ceiling, not a target answer length. Reasoning
tokens share the output budget ([OpenAI documentation](https://developers.openai.com/api/docs/guides/reasoning#controlling-costs)).

A response that ends for any reason other than a normal stop or tool calls,
including the output limit, is rejected before any of its tool calls start and
fails the turn. Completed tools remain in the journal; the failure cleanup
stops background work, suspends the sandbox and records the failure in history.
Interrupting the turn aborts an in-flight call through the run's signal.

Deploy with affected in-flight turns drained/interrupted; changing a replayed
Turn's control flow is not an in-place migration of old journals.

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
steering arrives while the program runs, the program moves to background work
and the model reads the steering right away. A race alone does not
cancel losing branches, but program return, failure, or turn interruption stops
and joins outstanding children. Completed side effects are not undone.

See [the PTC guide](tools.md#programmatic-tool-calling-ptc) for examples, limits,
failure handling, and the replay-safe `AGENT_PTC_ENABLED=false` opt-out.

## Interruption and stopping

- The interrupt signal asks the active run to end; steering asks it to
  continue with new direction.
- Agent stores an optional replacement user message separately from the
  interruption reason. The replacement belongs to a successor turn.
- On interruption the run interrupts and joins every foreground and background
  task. Results that completed are kept; calls without a result are recorded
  as cancelled with the interruption reason.
- Completion races that already won remain completed.
- The run then makes exactly one tool-free final model call over the retained
  context. Controls are no longer raced from there on, so a late interrupt
  cannot restart finalization.
- A candidate answer proposed while background work was outstanding is not
  kept, and is never published as the answer by itself.
- If final generation fails, the interrupted outcome carries an explanatory
  fallback.

The step limit uses the same cleanup/finalization mechanics but produces a
`stopped` outcome and a `stop` transcript event. External cancellation skips
model finalization and rethrows cancellation to Restate.

## Transcript and current-state notifications

`doTurn` appends semantic progress (`thinking` at each step, `waiting` while a
guardrail waits for a human) and structured tool `started`/`finished` events,
one per call, directly through its invocation-local history writer. Tool
events include IDs, names, the step, final statuses and, for tools that
declare one, a fixed `describe` label as the summary; never raw arguments or
results. Calls made by a program appear the same way.

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
2. One agent run per `doTurn`, with every exit reported to `Agent.onTurnEnd`.
3. FIFO steering and exact reconciliation counts.
4. No tool or background cancellation caused by steering.
5. Protocol-complete assistant tool-call and tool-result pairs.
6. Parallel foreground tools and joined cleanup.
7. Immediate start and selective cancellation of background work.
8. Honest completion-versus-cancellation races.
9. Tool-free interruption finalization using only retained work.
10. Distinct `completed`, `interrupted`, `stopped`, and `failed` outcomes.
11. The 50-step turn bound and separate per-program PTC limits, with no
    turn-wide tool-call budget that trips before them.
12. Stable profile input for the lifetime of a turn.
13. Guardrail evaluation before publishing text or executing each concrete
    tool call; gate PTC children, not their wrapper or source.
14. Durable approval before protected work and reevaluation after steering.
15. One initial transcript read followed by direct append-only writes.
