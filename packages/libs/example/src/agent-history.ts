// Durable conversation history for one Agent virtual object. Turn lifecycle
// state and pending work belong to agent-turn.ts.

import {type Operation, sharedState, state} from "@restatedev/restate-sdk-gen";
import type {ConversationEntry} from "./types.js";

export const history = {
  *read(): Operation<ConversationEntry[]> {
    return (yield* sharedState().get<ConversationEntry[]>("history")) ?? [];
  },

  *recent(limit: number): Operation<ConversationEntry[]> {
    const current =
      (yield* sharedState().get<ConversationEntry[]>("history")) ?? [];
    return current.slice(-limit);
  },

  *append(...entries: ConversationEntry[]): Operation<void> {
    if (entries.length === 0) {
      return;
    }
    const current =
      (yield* sharedState().get<ConversationEntry[]>("history")) ?? [];
    current.push(...entries);
    state().set("history", current);
  },

  // Remove steering that lost a completion race so the Agent coordinator can
  // append it again after that outcome as normal queued input.
  *takeLatestSteering(count: number): Operation<string[]> {
    if (count === 0) {
      return [];
    }

    const current =
      (yield* sharedState().get<ConversationEntry[]>("history")) ?? [];
    const messages: string[] = [];
    for (
      let index = current.length - 1;
      index >= 0 && messages.length < count;
      index--
    ) {
      const entry = current[index];
      if (entry.role === "user" && entry.delivery === "steer") {
        messages.push(entry.text);
        current.splice(index, 1);
      }
    }
    state().set("history", current);
    return messages.reverse();
  },
};
