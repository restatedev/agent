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
    for (const waiter of waiters) {
      waiter.interrupt(new restate.InterruptedError("Race settled"));
    }
    yield* restate.allSettled(waiters);
  }
}
