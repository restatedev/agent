# Composing handlers

Larger applications are made of small handlers that call each other through
Restate. Each call is a separate, durable invocation. The caller's journal
records the call and its result, so a replay never repeats a completed call.

## Request/response RPC

```ts
const quote = yield* restate.client(pricing).quote("sku-1"); // service
const total = yield* restate.client(counter, "user-42").add(1); // object: key
const done = yield* restate.client(onboarding, "wf-7").run("a@b.dev"); // workflow: ID
```

The client is typed from the definition you import, so input and output
types flow across services. `restate.client(...)` returns a `Future`: nothing
waits until you `yield*` it, and you can pass it to a combinator first.

Pass `Opts.from({idempotencyKey})` (from `@restatedev/restate-sdk`) as the
last argument to deduplicate a call across separate callers.

## One-way sends

```ts
import {SendOpts} from "@restatedev/restate-sdk";

restate.sendClient(emails).send("a@b.dev"); // now
restate.sendClient(reminders, "user-42").fire("pay rent", SendOpts.from({delay: {days: 30}}));
```

A send is journaled and delivered exactly once. The caller does not wait,
and a delayed send needs no running process while it waits. A send returns
`Future<InvocationReference>`. Yield it only when you need the invocation ID,
for example to store it for a later `attach` or `cancel`:

```ts
const ref = yield* restate.sendClient(reports).build(input);
restate.state().set("report", ref.id);
// later, possibly from another handler:
const report = yield* restate.invocation<Report>(storedId).attach();
restate.invocation(storedId).cancel();
```

## Fan-out, fan-in

```ts
const findings = yield* restate.all(
  questions.map((question) => restate.client(worker).research({question})),
);
```

| Combinator                  | Result                                                  |
| --------------------------- | ------------------------------------------------------- |
| `restate.all([...])`        | All values, in order; fails on the first failure        |
| `restate.allSettled([...])` | Every outcome, `{status, value \| reason}`; never fails |
| `restate.any([...])`        | First success; `AggregateError` if all fail             |
| `restate.race([...])`       | First to settle, success or failure                     |
| `restate.select({a, b})`    | `{tag, future}` of the winner; switch on `tag`          |

Timeout a call by racing it against a timer:

```ts
const {tag, future} = yield* restate.select({
  reply: restate.client(pricing).quote("sku-1"),
  timeout: restate.sleep({seconds: 30}),
});
if (tag === "timeout") throw new TerminalError("Pricing did not answer in time");
const price = yield* future;
```

## Concurrent in-process work: spawn

`restate.spawn(operation)` runs a generator concurrently inside the same
invocation and returns a `Task` (a Future you can also `interrupt()`). Use it
for concurrent multi-step work that does not deserve its own service, such as
racing two agents.

```ts
const tasks = candidates.map((c) => restate.spawn(answerWith(c, question)));
try {
  return yield* restate.any(tasks);
} finally {
  for (const task of tasks) task.interrupt(); // stop the losers
  yield* restate.allSettled(tasks); // and let their cleanup run
}
```

A spawned task still running when the handler returns is abandoned, and its
`finally` blocks never run. Always join or interrupt and then join.

Rule of thumb: use `restate.client` when the work should be separately
visible, retried, and addressable (its own invocation in the UI). Use
`spawn` for fine-grained concurrency within one handler.

## Contracts: iface and implement

Define a service's contract separately from its implementation when callers
(or agent tools) should depend on the shape only:

```ts
export const refundIface = restate.iface.service("RefundService", {
  issueRefund: restate.iface.schemas({
    input: z.object({orderId: z.string(), amountCents: z.number().int().positive()}),
    output: z.object({refundId: z.string()}),
    description: "Issue a refund for an order.",
  }),
});

export const refundService = restate.implement(refundIface, {
  handlers: {
    *issueRefund({orderId}) {
      return {refundId: `re_${orderId}`};
    },
  },
});

// Callers only need the interface:
yield* restate.client(refundIface).issueRefund({orderId: "O-1", amountCents: 500});
```

`restate.iface.object` and `restate.iface.workflow` work the same way, and
`restate.iface.shared.schemas` marks a shared handler.

## Scopes

`restate.scope("tenant-123").client(def).handler(input)` routes calls within
a named scope, for per-tenant concurrency and fairness. Query the docs MCP
server for flow-control details.
