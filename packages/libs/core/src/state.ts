// Typed accessors for durable Virtual Object state.

import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

/** The current Virtual Object's key. Agent and AgentSession use the agent id. */
export function objectKey(): string {
  const key = restate.handlerRequest().key;
  if (!key) throw new TerminalError("Object handlers require a key");
  return key;
}

/** An array stored under one key. An empty list clears the key. */
type ListState<T> = {
  /** Reads the list; works in shared and exclusive handlers. */
  get(): restate.Operation<T[]>;
  /** Replaces the list. Exclusive handlers only. */
  set(items: T[]): void;
  /** Replaces the list with `change(current)` and returns the result. */
  update(change: (items: T[]) => T[]): restate.Operation<T[]>;
  clear(): void;
};

export function listState<T>(key: string): ListState<T> {
  const list: ListState<T> = {
    *get() {
      return (yield* restate.sharedState().get<T[]>(key)) ?? [];
    },
    set(items) {
      if (items.length > 0) restate.state().set(key, items);
      else restate.state().clear(key);
    },
    *update(change) {
      const items = change(yield* list.get());
      list.set(items);
      return items;
    },
    clear() {
      restate.state().clear(key);
    },
  };
  return list;
}
