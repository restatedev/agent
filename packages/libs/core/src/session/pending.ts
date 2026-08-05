// Pending tools outlive the agent step that started them. This Turn-scoped
// registry owns lookup, completion races, selective cancellation, and final
// cleanup.

import * as restate from "@restatedev/restate-sdk-gen";
import type {ToolCall} from "../gateway/index.js";
import {raceBranches} from "../race.js";
import type {AgentToolContext, PendingEvent, ToolOutcome} from "./tools.js";
import * as agentTools from "./tools.js";

type PendingOperation = {
  step: number;
  call: ToolCall;
  task: restate.Task<PendingEvent>;
};

type PendingStep =
  | {type: "steering"}
  | {type: "completion"; event: PendingEvent}
  | {type: "interrupted"; reason: string};

/** Creates the Turn-scoped registry that supervises long-running tool work. */
export function createPendingOperations() {
  const active = new Map<string, PendingOperation>();

  return {
    get size(): number {
      return active.size;
    },

    describe(): string {
      return [...active.values()].map(({call}) => call.toolName).join(", ");
    },

    // Start new pending completions immediately, resolve cancellation requests
    // against older operations, then register the new operations. A completion
    // that wins the cancellation race remains completed.
    *apply(
      outcomes: ToolOutcome[],
      context: AgentToolContext,
      step: number,
    ): restate.Operation<{outcomes: ToolOutcome[]; events: PendingEvent[]}> {
      const starting = outcomes.flatMap((outcome): PendingOperation[] =>
        outcome.status === "pending"
          ? [
              {
                step,
                call: outcome.call,
                task: restate.spawn(
                  agentTools.complete(outcome.call, context, step),
                ),
              },
            ]
          : [],
      );
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
                reason:
                  reason instanceof Error ? reason.message : String(reason),
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
          reason: reason instanceof Error ? reason.message : String(reason),
        },
      }));
    },
  };
}
