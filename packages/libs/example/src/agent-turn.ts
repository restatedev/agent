// Active-turn management for one Agent virtual object. This component owns the
// `turn` and `pending` state keys plus the Turn invocation and signal lifecycle.
// It deliberately knows nothing about conversation history.

import * as restate from "@restatedev/restate-sdk-gen";
import {Turn} from "./turn.js";
import {
  type SteeringSignal,
  TURN_SIGNALS,
  type TurnOutcome,
  type TurnRequest,
} from "./types.js";

/** Durable state for the invocation currently owned by the Agent. */
type ActiveTurnState = {
  /** Turn service invocation ID and signal target. */
  id: string;
  /** Whether an interrupt was sent and the terminal outcome is still pending. */
  interrupting: boolean;
  /** Number of user messages carried by each steering signal sent in order. */
  steeringBatches: number[];
};

/** Information returned when an active turn is successfully retired. */
type FinishedTurn = {
  /** Number of user messages carried by unconsumed steering signals. */
  missedSteeringMessages: number;
  /** Number of messages accepted for the next turn while this one was active. */
  pendingMessages: number;
  /** Whether the Agent explicitly requested this turn's interruption. */
  interruptionRequested: boolean;
};

function* readActiveTurn(): restate.Operation<ActiveTurnState | undefined> {
  return (yield* restate.state().get<ActiveTurnState>("turn")) ?? undefined;
}

/**
 * Handler-scoped access to active-turn state for the current Agent object.
 *
 * These operations must run inside an Agent handler. The object is a namespace
 * over Restate's current context and holds no process-local state. Mutations
 * rely on exclusive handler serialization; history remains a separate concern.
 */
export const activeTurn = {
  /** Returns the current turn. */
  current: readActiveTurn,

  /**
   * Starts a Turn invocation and records it as active.
   *
   * The exclusive Agent caller is responsible for ensuring no turn is active.
   *
   * @returns The new invocation ID.
   */
  *start(request: TurnRequest): restate.Operation<string> {
    const started = yield* restate.sendClient(Turn).run(request);
    restate.state().set("turn", {
      id: started.id,
      interrupting: false,
      steeringBatches: [],
    });
    return started.id;
  },

  /**
   * Adds a message to the FIFO batch for the next turn.
   *
   * @returns The new number of pending messages.
   */
  *enqueue(message: string): restate.Operation<number> {
    const pending = (yield* restate.state().get<string[]>("pending")) ?? [];
    pending.push(message);
    restate.state().set("pending", pending);
    return pending.length;
  },

  /**
   * Signals the active invocation to interrupt and marks it as winding down.
   *
   * @returns The interrupted invocation ID, or `undefined` when no turn is
   * active or an interrupt is already in progress.
   */
  *interrupt(reason: string): restate.Operation<string | undefined> {
    const current = yield* readActiveTurn();
    if (!current || current.interrupting) {
      return undefined;
    }
    restate
      .invocation(current.id)
      .signal<string>(TURN_SIGNALS.interrupt)
      .resolve(reason);
    restate.state().set("turn", {...current, interrupting: true});
    return current.id;
  },

  /**
   * Promotes queued messages and a new instruction into the active Turn.
   *
   * Pending messages are drained into the signal as a separate FIFO list.
   *
   * @returns The structured steering signal, or `undefined` when no turn is
   * listening.
   */
  *steer(message: string): restate.Operation<SteeringSignal | undefined> {
    const current = yield* readActiveTurn();
    if (!current || current.interrupting) {
      return undefined;
    }

    const pending = (yield* restate.state().get<string[]>("pending")) ?? [];
    restate.state().clear("pending");
    const steering = {queued: pending, message};
    restate.state().set("turn", {
      ...current,
      steeringBatches: [...current.steeringBatches, steering.queued.length + 1],
    });
    restate
      .invocation(current.id)
      .signal<SteeringSignal>(TURN_SIGNALS.steering)
      .resolve(steering);
    return steering;
  },

  /**
   * Retires the matching active turn and drains its pending-message batch.
   *
   * Stale or duplicate outcomes are ignored. An explicit interruption
   * supersedes steering the Turn did not consume.
   *
   * @returns Reconciliation information, or `undefined` for an outcome that
   * does not belong to the active turn.
   */
  *finish(outcome: TurnOutcome): restate.Operation<FinishedTurn | undefined> {
    const current = yield* readActiveTurn();
    if (current?.id !== outcome.turnId) {
      return undefined;
    }

    restate.state().clear("turn");
    const pending = (yield* restate.state().get<string[]>("pending")) ?? [];
    restate.state().clear("pending");

    const missedSteeringMessages = current.interrupting
      ? 0
      : current.steeringBatches
          .slice(outcome.consumedSteering)
          .reduce((total, size) => total + size, 0);
    return {
      missedSteeringMessages,
      pendingMessages: pending.length,
      interruptionRequested: current.interrupting,
    };
  },
};
