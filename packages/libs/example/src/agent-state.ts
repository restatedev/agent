// Durable state owned by one Agent virtual object. This module knows the
// storage keys and shapes; controller policy stays in agent.ts.

import {type Operation, sharedState, state} from "@restatedev/restate-sdk-gen";
import type {ConversationEntry} from "./types.js";

// `interrupting` covers the wind-down between sending the interrupt signal and
// receiving the Turn's terminal outcome.
export type ActiveTurn = {
  id: string;
  interrupting: boolean;
  sentSteering: number;
};

// The previous revision stored the steering messages themselves. Normalize
// that short-lived state shape at the read boundary.
type StoredActiveTurn = Omit<ActiveTurn, "sentSteering"> & {
  sentSteering?: number | string[];
};

export const agentState = {
  *getTurn(): Operation<ActiveTurn | undefined> {
    const turn = yield* sharedState().get<StoredActiveTurn>("turn");
    if (!turn) {
      return undefined;
    }
    return {
      ...turn,
      sentSteering: Array.isArray(turn.sentSteering)
        ? turn.sentSteering.length
        : (turn.sentSteering ?? 0),
    };
  },

  *setTurn(turn: ActiveTurn): Operation<void> {
    state().set("turn", turn);
  },

  *clearTurn(): Operation<void> {
    state().clear("turn");
  },

  *getHistory(): Operation<ConversationEntry[]> {
    return (yield* sharedState().get<ConversationEntry[]>("history")) ?? [];
  },

  *appendHistory(...entries: ConversationEntry[]): Operation<void> {
    if (entries.length === 0) {
      return;
    }
    const history =
      (yield* sharedState().get<ConversationEntry[]>("history")) ?? [];
    history.push(...entries);
    state().set("history", history);
  },

  *getPending(): Operation<string[]> {
    return (yield* sharedState().get<string[]>("pending")) ?? [];
  },

  *enqueue(message: string): Operation<void> {
    const pending = (yield* sharedState().get<string[]>("pending")) ?? [];
    pending.push(message);
    state().set("pending", pending);
  },

  // Messages accepted during one turn drain as a batch so the follow-up can
  // answer them together instead of starting one near-identical turn each.
  *drainPending(): Operation<string[]> {
    const pending = (yield* sharedState().get<string[]>("pending")) ?? [];
    if (pending.length > 0) {
      state().clear("pending");
    }
    return pending;
  },

  // Remove steering that lost a completion race so the controller can append
  // it again after that outcome as normal queued input.
  *takeLatestSteering(count: number): Operation<string[]> {
    if (count === 0) {
      return [];
    }

    const history =
      (yield* sharedState().get<ConversationEntry[]>("history")) ?? [];
    const messages: string[] = [];
    for (
      let index = history.length - 1;
      index >= 0 && messages.length < count;
      index--
    ) {
      const entry = history[index];
      if (entry.role === "user" && entry.delivery === "steer") {
        messages.push(entry.text);
        history.splice(index, 1);
      }
    }
    state().set("history", history);
    return messages.reverse();
  },
};
