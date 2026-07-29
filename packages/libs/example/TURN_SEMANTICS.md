# Turn state-machine semantics

This is the behavioral reference for `src/turn.ts` and `src/turn-step.ts`.

## Ownership

- `Agent` owns the canonical transcript, queued user messages, active Turn
  state, persistent profile, human approval state, and steering reconciliation.
- The per-Agent profile contains user-set instructions, model-managed memories,
  and natural-language guardrails. Each Turn receives one stable snapshot.
- The transcript is an append-only event log. User entries retain their
  original acceptance route; steering and later activation are separate
  lifecycle events rather than entry rewrites.
- One `Turn.run` invocation owns the transient agent-turn state machine:
  working model messages, budgets, the steering cursor, pending tool tasks, and
  graceful interruption. This state is generator-local and replayed as part of
  the durable handler invocation; it is not Virtual Object state.
- `turn-step.ts` owns the bounded functional seam and its task supervision. A
  step receives a message snapshot and remaining tool budget, performs one
  agent-model call, gates the proposed action, executes an allowed foreground
  tool batch, and returns structured data. It owns no work after returning.
- `turn-steering.ts` owns one background signal receiver and a transient FIFO
  for steering accepted during the Turn.
- `turn-pending.ts` owns tool tasks that survive across steps, including
  completion races, selective cancellation, and cleanup.
- `agent-tools.ts` owns concrete tool definitions, validation, execution,
  completion, and conversion of outcomes into model messages.
- `Sandbox`, keyed by `agentId`, owns the external sandbox lifecycle. Sandbox
  state belongs to the Agent across conversation Turns. The first sandbox tool
  lazily acquires one shared Turn lease, while `Turn.run` releases it before
  reporting its terminal outcome.
- Tool calls execute locally inside the Turn handler. They are not RPCs.
  `manageMemory` and `humanApproval` call Agent handlers only for durable state
  that the Agent virtual object must own. Sandbox tools call the Sandbox object
  only for its serialized lease and lifecycle.

## Execution shape

- `Turn.run` loops until it completes, is interrupted, or exhausts a budget.
  Interruption and budget exhaustion share one guarded, tool-free finalization
  path over completed work.
- Each iteration spawns exactly one agent step. Turn supervises that task
  against interruption, then joins it before applying its result.
- The steering inbox receives signals concurrently with the step. Turn drains
  the inbox only after the step settles.
- The step owns one agent-model request, any guardrail evaluations and approval
  wait for its proposal, and the foreground tool batch it may produce. All
  allowed foreground calls are spawned before the step waits for the batch.
- Turn applies the returned action to its transient state. Tool outcomes are
  the declarative delta used to start or cancel pending operations.
- Pending completion tasks are deliberately outside the step. They remain
  owned by Turn across later iterations.

## Model steps

- A Turn performs at most eight model steps and 24 total tool calls.
- Each step receives a copy of the complete live model context accumulated by
  the Turn.
- Every agent-model call receives the same user-instruction snapshot.
  Persistent memories are injected once into the Turn's initial context as
  data, before the transcript.
- A normal step returns text, tool outcomes, a recoverable model error, or a
  tool-budget stop.
- Invalid or empty model output becomes a corrective user message and another
  step, within the same budget.
- Provider or orchestration failures stop every foreground and pending task.
  Durable interruption and cancellation errors are rethrown; other failures
  become a structured failed Turn outcome.
- Reaching either execution budget stops pending work and performs one
  tool-free final model call. The outcome is `interrupted`, preserving completed
  work instead of publishing an internal budget error as the assistant answer.
- The Agent-provided context remains exact for the lifetime of the Turn. When
  settled model/tool context accumulated inside the Turn exceeds a bounded
  character budget, a cheap scoped model reduces the prefix already observed
  by the agent model. Newly appended tool results, steering, and runtime events
  remain exact until the agent model has seen them.
- Turn context reduction never runs while an operation is pending, never
  rewrites the Agent transcript, and remains interruptible. If reduction
  exhausts its retries, the Turn keeps its exact context and disables further
  reduction attempts for that invocation.

## Guardrails

- A guardrail is a user-configured `{ id, rule }` policy. IDs are unique within
  the Agent profile and the complete list is snapshotted when a Turn starts.
- The main agent model does not receive that policy list. It proposes the
  requested work without trying to reproduce the runtime's approval behavior;
  only the policy evaluator receives guardrails.
- After the agent model proposes text or a complete tool batch, a cheap policy
  model evaluates that exact action before text is published or any tool in the
  batch starts. No guardrails means no policy-model call.
- The evaluator receives context starting at the latest real user input,
  including any tool and runtime evidence produced after it. Older turns and
  historical approval prose cannot expand a conditional policy into an
  allowlist; current-Turn approval and rejection state is supplied separately.
- The policy decision is `allow`, `deny`, or `require_approval`. Model failure
  fails closed under the gateway's Restate retry policy.
- `deny` returns a runtime policy message to the next agent step. The blocked
  text is not published and no tool in a blocked batch runs. If that model step
  is blocked by the same policy again, Turn completes with a deterministic,
  tool-free refusal instead of exhausting the step budget.
- `require_approval` durably registers a request on the Agent and waits on a
  Turn-scoped signal. Approval resumes the exact proposal; rejection blocks it
  and prevents another approval request for that policy in the current
  request.
- An approval covers its policy for later steps in the same request. Several
  applicable approval policies are resolved one at a time before the proposal
  runs.
- Steering changes the request. Turn clears approvals, rejections, and prior
  block retries before the next step so the updated work is evaluated again.
- The evaluator is model-based and therefore probabilistic. Once returned,
  however, its decision is enforced by deterministic Turn control flow.

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
- A policy approval wait is part of the step. Steering does not cancel it;
  interruption does. Any steering buffered before the step settles invalidates
  its approval decision before the next proposal.
- While Turn is waiting for pending work, steering is committed immediately
  and starts another step. Existing pending work continues.

## Foreground and pending tools

- Tools validate their own inputs and run locally only after the complete
  proposed batch passes the guardrail gate.
- `manageMemory` atomically sets or deletes keyed entries on the Agent. Only the
  active non-interrupting Turn can write, and the Agent stores at most 32
  memories. A successful tool result is a durable side effect even if later
  Turn work fails.
- Every foreground tool in one model response runs concurrently inside the
  spawned step and is joined before the step returns.
- Sandbox file operations and commands are foreground tools. Each client
  operation is one-shot and runs inside its own `restate.run` with cancellation
  propagation. `executeCommand` returns only after a terminal exit result;
  intentional background work must be launched and tracked explicitly by the
  shell command.
- Parallel sandbox tools share one in-flight borrow and later steps reuse the
  same lease. Dependent operations must be proposed in separate model steps,
  just like any other dependent tool calls.
- Exhausting a foreground tool's durable retry policy becomes a failed tool
  outcome for the model. Cancellation and Turn interruption still propagate.
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

## Stopped-turn finalization

- The interrupt signal asks Turn to end, while steering asks it to continue
  with new instructions.
- Execution limits also stop the Turn through this path, but originate from the
  runtime rather than an Agent interruption request.
- The Agent keeps the interruption reason separate from an optional replacement
  user message. The reason guides finalization of the old Turn; the message is
  appended to the immutable transcript and queued for a new Turn.
- A replacement message is still accepted if the old Turn is already
  interrupting. A reason-only repeat is ignored.
- During a step, Turn interrupts and joins the step task. The step joins every
  foreground tool, retains fulfilled outcomes, and represents interrupted
  calls as failures.
- A pending outcome returned by an interrupted step is represented as
  cancelled because Turn never starts its completion task.
- Turn stops and joins older pending operations. Races that already completed
  remain honest completion events.
- Turn adds the interruption instruction and retained tool/runtime results to
  its live context, then performs exactly one tool-free final model call.
- The final text is checked against guardrails before publication. Finalization
  cannot open a new approval while ending the Turn, so any `deny` or
  `require_approval` decision produces a deterministic withheld-response
  message instead.
- If interruption arrives while waiting after candidate text, that text remains
  in finalization context but is not published as the Turn answer by itself.
- If final response generation fails, Turn still returns an interrupted result
  with an explanatory fallback response.

## Execution events and transcript boundaries

- Turn reports semantic progress as `thinking`, `waiting`, and `finalizing`.
- Every allowed tool batch reports a structured `started` and `finished` event
  containing call IDs, tool names, and final statuses. The model may also emit
  one brief user-facing activity sentence before the batch starts.
- Sandbox reports only successful `provisioned` and `suspended` lifecycle
  transitions. Borrow, release, resume, and destroy remain runtime
  observability details.
- Progress and execution reports are one-way and cannot block model or tool
  execution on the Agent handler.
- Progress, activity, tool lifecycle, and sandbox events are transcript-visible
  for clients but omitted from model context and conversation compaction.
- Instruction and guardrail setters append metadata-only `profile` events.
  Approval registration and abandonment append `approval_request` and
  `approval_cancelled`; a delivered decision remains the model-visible
  `approval` event.
- History is the ordered change feed, while `profile` and `approvals` are the
  authoritative current-state snapshots.
- Raw reasoning, tool arguments, and tool results remain outside the canonical
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
12. Guardrail evaluation before publishing text or spawning any proposed tool.
13. Durable approval before a protected proposal and reevaluation after steering.
