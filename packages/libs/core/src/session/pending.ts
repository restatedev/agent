/**
 * Supervises tool calls whose work continues beyond one agent step.
 *
 * ## Turns, steps, and model tool calls
 *
 * An AgentSession `doTurn` invocation is one **turn**: it starts with user
 * input and runs until the agent produces a final answer or the turn is
 * interrupted or stopped. A turn usually contains several **steps**. Each
 * step gives the model the conversation so far and accepts one response:
 * text, tool calls, or an invalid/error result. Tool calls proposed together
 * are executed in parallel as part of that step.
 *
 * ```text
 * turn
 *   |
 *   +-- step 1: model --> [tool A, tool B] --> tool results
 *   |                                         |
 *   +-- step 2: model <-----------------------+
 *   |             |
 *   |             +-- final text, or more tool calls
 *   |
 *   +-- step N: model --> final text --> turn completes
 * ```
 *
 * Most tools finish during the step that invokes them. Some tools instead
 * return a `pending` outcome containing an operation id. That outcome is sent
 * to the model immediately, so the current step can finish, while this module
 * starts the tool's separate `complete` phase. For example, `sleep` creates a
 * Restate durable timer and `humanApproval` waits for a durable signal.
 *
 * The completion is deliberately not another model-protocol tool result for
 * the same call. The original tool result already said that the operation was
 * accepted and is pending. Once the operation settles, the turn adds an
 * explicit runtime message to the conversation before asking the model what
 * to do next.
 *
 * ```text
 * model calls sleep
 *        |
 *        v
 * execute() --> { status: "pending", operationId }
 *        |                         |
 *        |                         +--> model may continue to another step
 *        v
 * apply() spawns complete() --> Restate durable sleep/signal
 *                                      |
 *                                      v
 * next() observes completion --> runtime message --> next model step
 * ```
 *
 * ## Why this registry exists
 *
 * A model step is a bounded unit of planning and foreground execution; it
 * owns no state after it returns. Pending work instead belongs to the whole
 * turn. This turn-scoped registry bridges those lifetimes by retaining each
 * pending call and its spawned Restate task across later model steps.
 *
 * Although the registry is an in-memory `Map`, its tasks run inside the
 * durable `doTurn` invocation. Restate journals the effects used by those
 * tasks (timers, signals, calls, and so on), suspends the invocation while it
 * is parked, and reconstructs the same deterministic control flow during
 * recovery. Thus a pending tool can survive both the step that created it and
 * process failure without becoming an independent application-level job.
 * It cannot outlive its enclosing turn: normal early exit stops pending work,
 * and invocation cancellation abandons it through `cancelAll`.
 *
 * The registry has two principal operations:
 *
 * - `apply` commits the outcomes of an accepted tool step. It starts the
 *   completion phase of new pending tools and applies model-requested
 *   cancellation to previously pending tools.
 * - `next` parks the turn until pending work completes, steering arrives, or
 *   the user interrupts the turn. It reports one event; the turn loop owns the
 *   resulting conversation update and policy decision.
 */

import * as restate from "@restatedev/restate-sdk-gen";

import {errorMessage} from "../errors.js";
import type {ToolCall} from "../model/index.js";
import {raceBranches} from "../race.js";
import type {AgentToolContext, PendingEvent, ToolOutcome} from "./tools.js";
import * as agentTools from "./tools.js";

type PendingOperation = {
  /** Step that originally emitted the pending tool result. */
  step: number;
  call: ToolCall;
  /** Durable child task running the tool's completion phase. */
  task: restate.Task<PendingEvent>;
};

/** The next reason for a turn parked on pending work to resume. */
type PendingStep =
  | {type: "steering"}
  | {type: "completion"; event: PendingEvent}
  | {type: "interrupted"; reason: string};

/**
 * Creates the turn-scoped registry that supervises long-running tool work.
 *
 * Create exactly one registry for a `doTurn` invocation. Its mutable state is
 * intentionally local to that invocation and must not be shared across turns.
 */
export function createPendingOperations() {
  const active = new Map<string, PendingOperation>();

  return {
    get size(): number {
      return active.size;
    },

    describe(): string {
      return [...active.values()].map(({call}) => call.toolName).join(", ");
    },

    /**
     * Commits the pending-work effects of one accepted tool step.
     *
     * `agentStep` first executes every model-selected tool and returns a batch
     * of `ToolOutcome`s. The AgentSession calls `apply` only after it has
     * accepted that step's side effects. This method then interprets the two
     * non-terminal outcome variants:
     *
     * - `pending`: spawn `agentTools.complete(...)` immediately and retain the
     *   resulting Restate task under the tool-call id. The original pending
     *   outcome remains in the returned `outcomes`, because it is the immediate
     *   result paired with the model's tool call.
     * - `cancel_requested`: look up an operation retained by an earlier step,
     *   interrupt its completion task, join it, and replace the cancellation
     *   request with a terminal success or failure result for the
     *   `cancelOperation` tool call.
     *
     * New completion tasks are spawned before cancellations are processed so
     * independent durable work begins without waiting for cancellation joins.
     * They are added to the registry only after cancellation processing
     * succeeds. A cancellation can therefore target an operation from an
     * earlier step, not a pending operation created in the same batch.
     *
     * Cancellation is a race, not a rewrite of history. If the target task has
     * already completed when it is joined, its real completion is returned in
     * `events`, and the cancellation tool reports that it was too late. If the
     * interrupt wins, `events` contains a synthetic cancelled completion so
     * the transcript and model both see how the pending operation ended.
     * Missing operation ids become ordinary failed tool outcomes; they do not
     * fail the turn.
     *
     * The result separates two protocols:
     *
     * - `outcomes` completes the current model tool-call exchange and preserves
     *   the order of the model's calls.
     * - `events` reports older pending operations that became terminal while
     *   this batch was being applied.
     *
     * If applying the batch throws, every newly spawned but not-yet-registered
     * task is interrupted and joined before the error escapes. Operations that
     * were already registered remain owned by the turn.
     *
     * @param outcomes - Ordered immediate results from the current tool step.
     * @param context - Agent and turn capabilities needed by completion tasks.
     * @param step - Number of the model step that produced these outcomes.
     * @param handoffs - Foreground tasks the step stopped waiting for, keyed
     *   by call ID. Their pending outcomes adopt the running task instead of
     *   starting a `complete` phase.
     * @returns Outcomes for the current tool-call exchange plus terminal events
     *   discovered for operations created by earlier steps.
     */
    *apply(
      outcomes: ToolOutcome[],
      context: AgentToolContext,
      step: number,
      handoffs: ReadonlyMap<string, restate.Task<ToolOutcome>> = new Map(),
    ): restate.Operation<{outcomes: ToolOutcome[]; events: PendingEvent[]}> {
      const starting = outcomes.flatMap((outcome): PendingOperation[] => {
        if (outcome.status !== "pending") return [];
        const running = handoffs.get(outcome.call.toolCallId);
        return [
          {
            step,
            call: outcome.call,
            task: restate.spawn(
              running
                ? adopt(step, outcome.call, running)
                : agentTools.complete(outcome.call, context, step),
            ),
          },
        ];
      });
      const resolved: ToolOutcome[] = [];
      const events: PendingEvent[] = [];

      try {
        for (const outcome of outcomes) {
          if (outcome.status !== "cancel_requested") {
            resolved.push(outcome);
            continue;
          }

          const operation = active.get(outcome.operationId);
          if (!operation) {
            resolved.push({
              call: outcome.call,
              status: "failed",
              error: `no pending operation found for ${outcome.operationId}`,
            });
            continue;
          }

          operation.task.interrupt(
            new restate.InterruptedError(outcome.reason),
          );
          const [settled] = yield* restate.allSettled([operation.task]);
          active.delete(operation.call.toolCallId);

          if (settled.status === "fulfilled") {
            events.push(settled.value);
            resolved.push({
              call: outcome.call,
              status: "failed",
              error: `${outcome.operationId} completed before it could be cancelled`,
            });
            continue;
          }

          events.push({
            step: operation.step,
            call: operation.call,
            outcome: {status: "cancelled", reason: outcome.reason},
          });
          resolved.push({
            call: outcome.call,
            status: "succeeded",
            result: `Cancelled pending ${operation.call.toolName} operation ${outcome.operationId}`,
          });
        }

        for (const operation of starting) {
          active.set(operation.call.toolCallId, operation);
        }
        return {outcomes: resolved, events};
      } catch (error) {
        for (const operation of starting) {
          operation.task.interrupt(error);
        }
        yield* restate.allSettled(starting.map(({task}) => task));
        throw error;
      }
    },

    /**
     * Waits for the next event that can advance a turn with pending work.
     *
     * This is the synchronization boundary used after the model offers final
     * text while one or more operations are still pending. Finishing the turn
     * at that point would orphan its turn-scoped work, so the AgentSession
     * parks here and races three durable sources:
     *
     * ```text
     *                         +-- interrupt signal --> { type: "interrupted" }
     * AgentSession.next() ----+-- steering ready ---> { type: "steering" }
     *                         +-- any tool task ----> { type: "completion" }
     * ```
     *
     * The caller must invoke `next` only while `size > 0`; otherwise there are
     * no completion tasks to race. The supplied futures belong to the enclosing
     * turn: `steeringReady` says that the steering inbox can be drained, while
     * `interrupt` carries the reason the turn should stop.
     *
     * Exactly one event is returned per call:
     *
     * - A completion is removed from the registry before it is returned. The
     *   caller records it, converts it to a runtime model message, and starts a
     *   fresh model step. Other pending tasks continue running.
     * - Steering only wakes the caller. This method neither drains steering nor
     *   changes pending tasks; the turn incorporates the new messages and lets
     *   the model decide whether existing work should continue or be cancelled.
     * - Interruption likewise reports intent without stopping tasks here. The
     *   turn's finalization path owns cancellation, transcript updates, and its
     *   final response, keeping cleanup policy out of this readiness primitive.
     *
     * `raceBranches` cancels only its temporary losing waiters. It does not
     * cancel the registered completion tasks merely because steering or an
     * interrupt won this race.
     *
     * @param steeringReady - Resolves when the turn's steering inbox is
     *   non-empty; the caller remains responsible for draining that inbox.
     * @param interrupt - Resolves with the reason for interrupting this turn.
     * @returns The single completion, steering, or interruption event that won
     *   the durable race.
     */
    *next(
      steeringReady: restate.Future<void>,
      interrupt: restate.Future<string>,
    ): restate.Operation<PendingStep> {
      const selected = yield* raceBranches({
        interrupt,
        steering: steeringReady,
        completion: restate.race([...active.values()].map(({task}) => task)),
      });
      if (selected.tag === "interrupt") {
        return {type: "interrupted", reason: selected.value};
      }
      if (selected.tag === "steering") {
        return {type: "steering"};
      }
      active.delete(selected.value.call.toolCallId);
      return {type: "completion", event: selected.value};
    },

    *stop(reason: unknown): restate.Operation<PendingEvent[]> {
      const stopped = [...active.values()];
      active.clear();
      for (const operation of stopped) {
        operation.task.interrupt(reason);
      }
      const settled = yield* restate.allSettled(stopped.map(({task}) => task));
      return settled.map((result, index) =>
        result.status === "fulfilled"
          ? result.value
          : {
              step: stopped[index].step,
              call: stopped[index].call,
              outcome: {
                status: "cancelled",
                reason: errorMessage(reason),
              },
            },
      );
    },

    /**
     * Abandons every pending operation without waiting for cancelled work.
     *
     * Invocation cancellation has already interrupted the whole coroutine
     * tree. This synchronous snapshot lets the cancelled root record cleanup
     * and hand control back to the Agent without parking on those children.
     */
    cancelAll(reason: unknown): PendingEvent[] {
      const stopped = [...active.values()];
      active.clear();
      for (const operation of stopped) {
        operation.task.interrupt(reason);
      }
      return stopped.map(({step, call}) => ({
        step,
        call,
        outcome: {
          status: "cancelled",
          reason: errorMessage(reason),
        },
      }));
    },
  };
}

// Reports a handed-off foreground tool as a pending completion. Stopping or
// cancelling the operation interrupts this wrapper, which forwards the
// interrupt into the running tool and joins it so its cleanup runs.
function* adopt(
  step: number,
  call: ToolCall,
  running: restate.Task<ToolOutcome>,
): restate.Operation<PendingEvent> {
  let outcome: ToolOutcome;
  try {
    outcome = yield* running;
  } catch (error) {
    running.interrupt(error);
    yield* restate.allSettled([running]);
    throw error;
  }
  switch (outcome.status) {
    case "succeeded":
      return {
        step,
        call,
        outcome: {status: "succeeded", result: outcome.result},
      };
    case "failed":
      return {step, call, outcome: {status: "failed", error: outcome.error}};
    default:
      return {
        step,
        call,
        outcome: {
          status: "failed",
          error: `Unresolved foreground tool outcome: ${outcome.status}`,
        },
      };
  }
}
