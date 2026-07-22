// Active-turn management for one Agent virtual object. This component owns the
// `turn` and `pending` state keys plus the Turn invocation and signal lifecycle.
// It deliberately knows nothing about conversation history.

import {type Operation, sharedState, state} from "@restatedev/restate-sdk-gen";
import {interruptTurn, startTurn, steerTurn} from "./turn.js";
import type {TurnOutcome, TurnRequest} from "./types.js";

type ActiveTurnState = {
  id: string;
  interrupting: boolean;
  sentSteering: number;
};

type FinishedTurn = {
  missedSteering: number;
  pending: string[];
};

// The previous revision stored the steering messages themselves. Normalize
// that short-lived state shape when an active turn is read.
type StoredActiveTurn = Omit<ActiveTurnState, "sentSteering"> & {
  sentSteering?: number | string[];
};

export const activeTurn = {
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

  *start(request: TurnRequest): Operation<void> {
    if (yield* this.current()) {
      return;
    }
    const id = yield* startTurn(request);
    state().set("turn", {id, interrupting: false, sentSteering: 0});
  },

  *enqueue(message: string): Operation<void> {
    const pending = (yield* sharedState().get<string[]>("pending")) ?? [];
    pending.push(message);
    state().set("pending", pending);
  },

  *pending(): Operation<string[]> {
    return (yield* sharedState().get<string[]>("pending")) ?? [];
  },

  *interrupt(reason: string): Operation<string | undefined> {
    const current = yield* this.current();
    if (!current || current.interrupting) {
      return undefined;
    }
    interruptTurn(current.id, reason);
    state().set("turn", {...current, interrupting: true});
    return current.id;
  },

  *steer(message: string): Operation<boolean> {
    const current = yield* this.current();
    if (!current || current.interrupting) {
      return false;
    }
    state().set("turn", {
      ...current,
      sentSteering: current.sentSteering + 1,
    });
    steerTurn(current.id, message);
    return true;
  },

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
