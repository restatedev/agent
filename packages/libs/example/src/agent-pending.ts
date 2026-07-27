// Pending tools outlive the agent step that started them. This registry owns
// lookup, completion races, selective cancellation, and final cleanup.

import {
  allSettled,
  type Future,
  InterruptedError,
  type Operation,
  race,
  select,
  spawn,
  type Task,
} from "@restatedev/restate-sdk-gen";
import {
  type AgentToolContext,
  agentTools,
  type PendingEvent,
  type ToolOutcome,
} from "./agent-tools.js";
import type {ToolCall} from "./model.js";
import type {SteeringSignal} from "./types.js";

type PendingOperation = {
  call: ToolCall;
  task: Task<PendingEvent>;
};

type PendingStep =
  | {type: "steering"; steering: SteeringSignal}
  | {type: "completion"; event: PendingEvent}
  | {type: "interrupted"; reason: string};

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
    ): Operation<{outcomes: ToolOutcome[]; events: PendingEvent[]}> {
      const starting = outcomes.flatMap((outcome): PendingOperation[] =>
        outcome.status === "pending"
          ? [
              {
                call: outcome.call,
                task: spawn(agentTools.complete(outcome.call, context)),
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

          operation.task.interrupt(new InterruptedError(outcome.reason));
          const [settled] = yield* allSettled([operation.task]);
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
        yield* allSettled(starting.map(({task}) => task));
        throw error;
      }
    },

    *next(
      steering: Future<SteeringSignal>,
      interrupt: Future<string>,
    ): Operation<PendingStep> {
      const selected = yield* select({
        interrupt,
        steering,
        completion: race([...active.values()].map(({task}) => task)),
      });
      if (selected.tag === "interrupt") {
        return {type: "interrupted", reason: yield* selected.future};
      }
      if (selected.tag === "steering") {
        return {
          type: "steering",
          steering: yield* selected.future,
        };
      }
      const event = yield* selected.future;
      active.delete(event.call.toolCallId);
      return {type: "completion", event};
    },

    *stop(reason: unknown): Operation<PendingEvent[]> {
      const stopped = [...active.values()];
      active.clear();
      for (const operation of stopped) {
        operation.task.interrupt(reason);
      }
      const settled = yield* allSettled(stopped.map(({task}) => task));
      return settled.map((result, index) =>
        result.status === "fulfilled"
          ? result.value
          : {
              call: stopped[index].call,
              outcome: {
                status: "cancelled",
                reason:
                  reason instanceof Error ? reason.message : String(reason),
              },
            },
      );
    },
  };
}
