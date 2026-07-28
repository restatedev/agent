# Turn state-machine semantics

This is the behavioral reference for `src/turn.ts` and `src/turn-step.ts`.

## Ownership

- `Agent` owns the canonical transcript, queued user messages, active Turn
  state, persistent profile, human approval state, and steering reconciliation.
- The per-Agent profile contains user-set instructions, model-managed memories,
  and capability guardrails. Each Turn receives one stable snapshot.
- The transcript is an append-only event log. User entries retain their
  original acceptance route; steering and later activation are separate
  lifecycle events rather than entry rewrites.
- One `Turn.run` invocation owns the transient agent-turn state machine:
  working model messages, budgets, the steering cursor, pending tool tasks, and
  graceful interruption. This state is generator-local and replayed as part of
  the durable handler invocation; it is not Virtual Object state.
- `turn-step.ts` owns the bounded functional seam and its task supervision. A
  step receives a message snapshot and remaining tool budget, performs one
  model call, executes that response's foreground tools, and returns structured
  data. It owns no work after returning.
- `turn-steering.ts` owns one background signal receiver and a transient FIFO
  for steering accepted during the Turn.
- `turn-pending.ts` owns tool tasks that survive across steps, including
  completion races, selective cancellation, and cleanup.
- `agent-tools.ts` owns concrete tool definitions, validation, execution,
  capability checks, completion, and conversion of outcomes into model
  messages.
- Tool calls execute locally inside the Turn handler. They are not RPCs.
  `manageMemory` and `humanApproval` call Agent handlers only for durable state
  that the Agent virtual object must own.

## Execution shape

- `Turn.run` loops until it completes, is interrupted, or exhausts a budget.
- Each iteration spawns exactly one agent step. Turn supervises that task
  against interruption, then joins it before applying its result.
- The steering inbox receives signals concurrently with the step. Turn drains
  the inbox only after the step settles.
- The step owns one model request and the foreground tool batch it may produce.
  All foreground calls are spawned before the step waits for the batch.
- Turn applies the returned action to its transient state. Tool outcomes are
  the declarative delta used to start or cancel pending operations.
- Pending completion tasks are deliberately outside the step. They remain
  owned by Turn across later iterations.

## Model steps

- A Turn performs at most eight model steps and 24 total tool calls.
- Each step receives a copy of the complete live model context accumulated by
  the Turn.
- Every model call receives the same user-instruction and capability-guardrail
  snapshot. Persistent memories are injected once into the Turn's initial
  context as data, before the transcript.
- A normal step returns text, tool outcomes, a recoverable model error, or a
  tool-budget failure.
- Invalid or empty model output becomes a corrective user message and another
  step, within the same budget.
- Provider or orchestration failures stop every foreground and pending task.
  Durable interruption and cancellation errors are rethrown; other failures
  become a structured failed Turn outcome.

## Steering

- Repeated resolutions of the steering signal form a durable FIFO queue.
- One steering signal contains `{ queued, message }`: queued messages promoted
  into the active Turn remain distinct from the explicit steering instruction.
- Turn increments `consumedSteering` once for every steering update committed
  to its working context. Agent uses that count to recover instructions that
  lost a completion race.
- Agent appends a steering boundary for every signal it sends. If the Turn
  finishes before consuming one, a later dispatch boundary activates those
  unchanged user entries in the next Turn.
- Steering never cancels a step. A background fiber drains the durable signal
  queue into a transient FIFO while the model and foreground tools run.
  The FIFO's resettable channel only announces empty-to-non-empty transitions;
  it is not the durable source.
  - Tool outcomes are committed first, followed by buffered steering.
  - A text or model-error result has no side effects and is discarded as stale
    when steering arrived during its step.
- While Turn is waiting for pending work, steering is committed immediately
  and starts another step. Existing pending work continues.

## Foreground and pending tools

- Every tool declares a capability. After input validation and before local
  execution, a matching guardrail produces a failed tool result without
  running the tool.
- `manageMemory` atomically sets or deletes keyed entries on the Agent. Only the
  active non-interrupting Turn can write, and the Agent stores at most 32
  memories. A successful tool result is a durable side effect even if later
  Turn work fails.
- Every foreground tool in one model response runs concurrently inside the
  spawned step and is joined before the step returns.
- Turn commits the assistant tool-call message and one complete matching
  tool-result message together.
- A foreground result is succeeded, failed, pending, or
  cancellation-requested.
- Pending completions start immediately when Turn applies the step result.
- Cancellation requests are resolved against operations that were pending
  before that step. Newly pending operations from the same result become
  addressable only after those cancellations resolve.
- Pending operations are keyed by stable tool-call ID.
- A completed pending task becomes a model-visible runtime event and leaves the
  registry.
- `cancelOperation` interrupts and joins only the selected pending task. A
  completion that wins the race remains a completion, and unrelated operations
  continue.
- Text is only a candidate final answer while pending operations remain. Turn
  waits for completion, steering, or interruption before running another step.

## Graceful interruption

- The interrupt signal asks Turn to end, while steering asks it to continue
  with new instructions.
- During a step, Turn interrupts and joins the step task. The step joins every
  foreground tool, retains fulfilled outcomes, and represents interrupted
  calls as failures.
- A pending outcome returned by an interrupted step is represented as
  cancelled because Turn never starts its completion task.
- Turn stops and joins older pending operations. Races that already completed
  remain honest completion events.
- Turn adds the interruption instruction and retained tool/runtime results to
  its live context, then performs exactly one tool-free final model call.
- If interruption arrives while waiting after candidate text, that text remains
  in finalization context but is not published as the Turn answer by itself.
- If final response generation fails, Turn still returns an interrupted result
  with an explanatory fallback response.

## Progress and transcript boundaries

- Turn reports only semantic progress: `thinking`, `tools`, `waiting`, and
  `finalizing`.
- Progress is one-way and cannot block model or tool execution on the Agent
  handler.
- Raw model text, tool calls, and tool results remain outside the canonical
  user-facing transcript.
- Every completed, interrupted, or failed outcome includes
  `consumedSteering`.

## Refactoring constraints

Any rewrite must preserve:

1. Turn ownership of transient cross-step state.
2. One bounded spawned task per agent step.
3. FIFO steering and exact reconciliation counts.
4. No cancellation caused by steering.
5. Protocol-complete assistant tool-call and tool-result pairs.
6. Parallel foreground tools and joined cleanup.
7. Immediate start and selective cancellation of pending work.
8. Honest completion-versus-cancellation races.
9. Tool-free interruption finalization using only retained work.
10. The eight-step and 24-tool-call budgets.
11. Stable instructions, memories, and guardrails for the lifetime of a Turn.
12. Guardrail checks after validation and before tool execution.
