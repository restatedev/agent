// Task supervision helpers for sdk-gen operations.

import * as restate from "@restatedev/restate-sdk-gen";

type FutureValue<F> = F extends restate.Future<infer Value> ? Value : never;

type RaceResult<Branches extends Record<string, restate.Future<unknown>>> = {
  [Tag in keyof Branches]: {
    tag: Tag;
    value: FutureValue<Branches[Tag]>;
  };
}[keyof Branches];

function* tagged<Tag extends string, Value>(
  tag: Tag,
  future: restate.Future<Value>,
): restate.Operation<{tag: Tag; value: Value}> {
  return {tag, value: yield* future};
}

/**
 * Races futures and returns the winning value with its branch name.
 *
 * Each branch is awaited by a task so invocation cancellation becomes an
 * actual rejected branch rather than a synthetic readiness notification that
 * would require awaiting the still-pending source again.
 */
export function* raceBranches<
  Branches extends Record<string, restate.Future<unknown>>,
>(branches: Branches): restate.Operation<RaceResult<Branches>> {
  const waiters = Object.entries(branches).map(([tag, future]) =>
    restate.spawn(tagged(tag, future)),
  );
  try {
    return (yield* restate.race(waiters)) as RaceResult<Branches>;
  } finally {
    yield* interruptAndJoin(
      waiters,
      new restate.InterruptedError("Race settled"),
    );
  }
}

/**
 * Interrupts every task and waits for all of them to settle, so their
 * cleanup runs before the caller continues.
 */
export function* interruptAndJoin<T>(
  tasks: readonly restate.Task<T>[],
  reason: unknown,
): restate.Operation<restate.FutureSettledResult<T>[]> {
  for (const task of tasks) task.interrupt(reason);
  return yield* restate.allSettled(tasks);
}
