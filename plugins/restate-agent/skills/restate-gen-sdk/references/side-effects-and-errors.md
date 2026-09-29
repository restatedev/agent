# Side effects, retries, and errors

## Journal every side effect

Anything that talks to the outside world, or could return a different value
on replay, runs inside `restate.run`. The result is recorded; a replay returns
the recording instead of running the closure again.

```ts
function* chargeCard(orderId: string, cents: number) {
  return yield* restate.run(
    async ({signal}) => {
      const response = await fetch("https://payments.example/charge", {
        method: "POST",
        body: JSON.stringify({orderId, cents}),
        headers: {"idempotency-key": orderId},
        signal, // aborted when the invocation is cancelled
      });
      if (response.status === 402) throw new TerminalError("Card declined");
      return (await response.json()) as {chargeId: string};
    },
    {name: "charge card"},
  );
}
```

- The closure is `async` and receives an `AbortSignal`. Pass the signal to
  fetch and SDK calls.
- Do not call `restate.*` inside the closure. Compose outside it.
- The closure can run more than once when an attempt fails before its result
  is recorded. Give external writes an idempotency key.
- A generator helper like `chargeCard` is itself an operation. Call it with
  `yield* chargeCard(...)` from any handler.

## Deterministic helpers

| Instead of            | Use                                                |
| --------------------- | -------------------------------------------------- |
| `Date.now()`          | `yield* restate.date().now()`                      |
| `Math.random()`       | `restate.rand().random()`                          |
| `crypto.randomUUID()` | `restate.rand().uuidv4()`                          |
| `setTimeout`          | `yield* restate.sleep({seconds: 5})`               |
| `console.log`         | `restate.logger().info(...)` (quiet during replay) |

## Retries

Without a `retry` option, a thrown error falls back to the invocation's
retry policy. The server default retries with backoff and, after 70
attempts, pauses the invocation until someone resumes it. Set a policy on
the run to bound it:

```ts
const retry = {
  maxAttempts: 5, // includes the first attempt
  initialInterval: {milliseconds: 250},
  exponentiationFactor: 2,
  maxInterval: {seconds: 5},
  maxDuration: {seconds: 30},
};
yield* restate.run(() => callFlakyApi(), {name: "call api", retry});
```

When the policy is exhausted, `run` throws a `TerminalError`.

## Terminal errors

`TerminalError` (from `@restatedev/restate-sdk`) means "do not retry". It
fails the handler, and the caller receives the error. Any other thrown error
makes Restate retry the invocation from the journal.

```ts
import {TerminalError} from "@restatedev/restate-sdk";

if (!order) throw new TerminalError(`Unknown order ${orderId}`);
```

Catch terminal errors from a child call with `try`/`catch` around its
`yield*` to compensate (see the saga pattern in `patterns.md`).

## Cancellation

Cancelling an invocation (from the UI, the CLI, or `ref.cancel()`) raises a
`CancelledError`, a `TerminalError` subclass, at the handler's next `yield*`.
Catch it to run compensation, then rethrow. Cancellation also propagates to
calls the handler is awaiting.

`task.interrupt()` on a spawned task raises `restate.InterruptedError` inside
that task. It is a plain `Error`, not a terminal one; treat it like
cancellation and let it propagate.

To retry after a delay the server names, for example an HTTP `Retry-After`,
throw `RetryableError.from(cause, {retryAfter: {seconds: 30}})` from the
`run` closure.
