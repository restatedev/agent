// Pending operations: tool calls whose work outlives the step that made them.
//
// A step's model call may return tool results immediately, or a tool may
// answer `pending` with an operation ID (`sleep` starts a durable timer,
// `humanApproval` waits for a signal). The model sees that pending result at
// once, so the step can finish; this registry runs the tool's `complete` phase
// as a task of the turn. When it settles, the turn adds a runtime message
// before the next model step rather than a second result for the same call.
//
//   model calls sleep -> execute() -> {status: "pending", operationId}
//   apply() spawns complete() --------> durable timer / signal
//   next() observes the completion ---> runtime message -> next model step
//
// The Map is in-memory, but its tasks run inside the durable doTurn
// invocation, so Restate journals their effects and recovery rebuilds them.
// Pending work never outlives its turn: an early exit stops it and
// invocation cancellation abandons it through `cancelAll`.

import * as restate from "@restatedev/restate-sdk-gen";

import {errorMessage} from "../errors.js";
import type {ToolCall} from "../model/index.js";
import {interruptAndJoin, raceBranches} from "../tasks.js";
import {failed} from "../tool-api/index.js";
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
  | {type: "interrupted"; reason: string}
  | {type: "idle"};

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
     * Commits the pending effects of one accepted tool step.
     *
     * - `pending` outcomes start their `complete` phase (or adopt the running
     *   task a step handed off) and stay in `outcomes`, since they are the
     *   immediate result of the model's call.
     * - `cancel_requested` outcomes interrupt and join an operation from an
     *   earlier step and become the `cancelOperation` call's result. The
     *   target may already have finished: its real completion is then
     *   reported and the cancellation says it was too late.
     *
     * @returns `outcomes` for this step's tool calls, in order, and `events`
     * for earlier operations that ended while applying them. If applying
     * throws, the newly started tasks are stopped before the error escapes.
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

          // Unregister before interrupting, so a concurrent `next` sees the
          // rejection as a cancellation rather than a failure.
          active.delete(operation.call.toolCallId);
          const [settled] = yield* interruptAndJoin(
            [operation.task],
            new restate.InterruptedError(outcome.reason),
          );

          if (settled.status === "fulfilled") {
            events.push(settled.value);
            resolved.push({
              call: outcome.call,
              status: "failed",
              error: `${outcome.operationId} completed before it could be cancelled`,
            });
            continue;
          }

          events.push(cancelledEvent(operation, outcome.reason));
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
        yield* interruptAndJoin(
          starting.map(({task}) => task),
          error,
        );
        throw error;
      }
    },

    /**
     * Parks the turn until a pending operation completes, steering arrives or
     * the turn is interrupted, and reports which. A completion is removed from
     * the registry; steering and interruption leave every task running, since
     * the turn decides what happens next.
     *
     * A handed-off program may cancel another operation while the turn is
     * parked here. `apply` then removes it and reports the cancellation to
     * the program, so its rejected task is skipped rather than failing the
     * turn. Reports `idle` once nothing is left to wait for.
     */
    *next(
      steeringReady: restate.Future<void>,
      interrupt: restate.Future<string>,
    ): restate.Operation<PendingStep> {
      while (active.size > 0) {
        const selected = yield* raceBranches({
          interrupt,
          steering: steeringReady,
          completion: restate.spawn(firstSettled([...active.values()])),
        });
        if (selected.tag === "interrupt") {
          return {type: "interrupted", reason: selected.value};
        }
        if (selected.tag === "steering") {
          return {type: "steering"};
        }

        const {operation, settled} = selected.value;
        const id = operation.call.toolCallId;
        if (active.get(id) !== operation) {
          // Already cancelled and reported by `apply`.
          continue;
        }
        if (settled.status === "rejected") {
          // Still registered, so nothing in this turn cancelled it: only
          // invocation cancellation rejects a completion task.
          throw settled.reason;
        }
        active.delete(id);
        return {type: "completion", event: settled.value};
      }
      return {type: "idle"};
    },

    /** Stops every operation and waits for each to settle. */
    *stop(reason: unknown): restate.Operation<PendingEvent[]> {
      const stopped = [...active.values()];
      active.clear();
      const settled = yield* interruptAndJoin(
        stopped.map(({task}) => task),
        reason,
      );
      return settled.map((result, index) =>
        result.status === "fulfilled"
          ? result.value
          : cancelledEvent(stopped[index], errorMessage(reason)),
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
      for (const operation of stopped) operation.task.interrupt(reason);
      return stopped.map((operation) =>
        cancelledEvent(operation, errorMessage(reason)),
      );
    },
  };
}

type SettledOperation = {
  operation: PendingOperation;
  settled: restate.FutureSettledResult<PendingEvent>;
};

// Waits for the first of `operations` to settle without rethrowing its
// rejection, so `next` can tell an operation cancelled by `apply` from a
// real failure. The per-operation waiters are stopped once one wins; that
// never interrupts the operations themselves.
function* firstSettled(
  operations: PendingOperation[],
): restate.Operation<SettledOperation> {
  const waiters = operations.map((operation) =>
    restate.spawn(settledOf(operation)),
  );
  try {
    return yield* restate.race(waiters);
  } finally {
    yield* interruptAndJoin(
      waiters,
      new restate.InterruptedError("Pending wait settled"),
    );
  }
}

function* settledOf(
  operation: PendingOperation,
): restate.Operation<SettledOperation> {
  const [settled] = yield* restate.allSettled([operation.task]);
  return {operation, settled};
}

function cancelledEvent(
  {step, call}: PendingOperation,
  reason: string,
): PendingEvent {
  return {step, call, outcome: {status: "cancelled", reason}};
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
    yield* interruptAndJoin([running], error);
    throw error;
  }
  // The tool's transcript was already recorded when it ran.
  if (outcome.status === "succeeded")
    return {step, call, outcome: {status: "succeeded", result: outcome.result}};
  if (outcome.status === "failed")
    return {step, call, outcome: failed(outcome.error)};
  return {
    step,
    call,
    outcome: failed(`Unresolved foreground tool outcome: ${outcome.status}`),
  };
}
