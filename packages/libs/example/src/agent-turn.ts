// Active-turn management for one Agent virtual object. This component owns the
// `turn` and `pending` state keys plus the Turn invocation and signal lifecycle.
// It deliberately knows nothing about conversation history.

import {
  invocation,
  type Operation,
  sendClient,
  sharedState,
  state,
} from "@restatedev/restate-sdk-gen";
import {Turn} from "./turn.js";
import type {TurnOutcome, TurnRequest} from "./types.js";

/** Durable state for the invocation currently owned by the Agent. */
type ActiveTurnState = {
  /** Turn service invocation ID and signal target. */
  id: string;
  /** Whether an interrupt was sent and the terminal outcome is still pending. */
  interrupting: boolean;
  /** Number of steering signals sent to this invocation. */
  sentSteering: number;
};

/** Information returned when an active turn is successfully retired. */
type FinishedTurn = {
  /** Number of steering signals left unconsumed when the Turn finished. */
  missedSteering: number;
  /** Messages accepted for the next turn while this one was active. */
  pending: string[];
};

/** Previously persisted shape accepted while normalizing active-turn state. */
type StoredActiveTurn = Omit<ActiveTurnState, "sentSteering"> & {
  sentSteering?: number | string[];
};

/**
 * Owns active-turn and pending-message state for the current Agent object.
 *
 * Methods must run inside an Agent handler. Mutating methods rely on exclusive
 * handler serialization; this component deliberately does not access history.
 */
export const activeTurn = {
  /** Returns the current turn, normalizing state written by earlier versions. */
  *current(): Operation<ActiveTurnState | undefined> {
    const current = yield* sharedState().get<StoredActiveTurn>("turn");
    if (!current) {
      return undefined;
    }
    return {
      ...current,
      sentSteering: Array.isArray(current.sentSteering)
        ? current.sentSteering.length
        : (current.sentSteering ?? 0),
    };
  },

  /**
   * Starts a Turn invocation and records it as active.
   *
   * Does nothing when a turn is already active.
   */
  *start(request: TurnRequest): Operation<void> {
    if (yield* this.current()) {
      return;
    }
    const started = yield* sendClient(Turn).run(request);
    state().set("turn", {
      id: started.id,
      interrupting: false,
      sentSteering: 0,
    });
  },

  /** Adds a message to the FIFO batch for the next turn. */
  *enqueue(message: string): Operation<void> {
    const pending = (yield* sharedState().get<string[]>("pending")) ?? [];
    pending.push(message);
    state().set("pending", pending);
  },

  /** Returns messages currently waiting for the next turn. */
  *pending(): Operation<string[]> {
    return (yield* sharedState().get<string[]>("pending")) ?? [];
  },

  /**
   * Signals the active invocation to interrupt and marks it as winding down.
   *
   * @returns The interrupted invocation ID, or `undefined` when no turn is
   * active or an interrupt is already in progress.
   */
  *interrupt(reason: string): Operation<string | undefined> {
    const current = yield* this.current();
    if (!current || current.interrupting) {
      return undefined;
    }
    invocation(current.id).signal<string>("interrupt").resolve(reason);
    state().set("turn", {...current, interrupting: true});
    return current.id;
  },

  /**
   * Sends one steering instruction to an active, listening Turn invocation.
   *
   * @returns Whether the steering signal was accepted.
   */
  *steer(message: string): Operation<boolean> {
    const current = yield* this.current();
    if (!current || current.interrupting) {
      return false;
    }
    state().set("turn", {
      ...current,
      sentSteering: current.sentSteering + 1,
    });
    invocation(current.id).signal<string>("steering").resolve(message);
    return true;
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
  *finish(outcome: TurnOutcome): Operation<FinishedTurn | undefined> {
    const current = yield* this.current();
    if (current?.id !== outcome.turnId) {
      return undefined;
    }

    state().clear("turn");
    const pending = (yield* sharedState().get<string[]>("pending")) ?? [];
    if (pending.length > 0) {
      state().clear("pending");
    }

    return {
      missedSteering:
        outcome.status === "interrupted"
          ? 0
          : Math.max(0, current.sentSteering - outcome.consumedSteering),
      pending,
    };
  },
};
