# Handlers and state

## Services

A service is a named group of generator handlers. A handler takes zero or one
input and returns a JSON-serializable value.

```ts
import * as restate from "@restatedev/restate-sdk-gen";

export const pricing = restate.service({
  name: "Pricing",
  handlers: {
    *quote(sku: string) {
      return yield* restate.run(() => fetchPrice(sku), {name: "fetch price"});
    },
  },
});
```

Call it over HTTP at `POST <ingress>/Pricing/quote` with a JSON body.

## Validated input and output

Wrap a handler in `restate.schemas` to validate with any Standard Schema
library (Zod, Valibot, ArkType). The schemas also appear in Restate's UI and
discovery. `.meta({default})` prefills the request editor.

```ts
import {z} from "zod";

export const triage = restate.service({
  name: "Triage",
  handlers: {
    classify: restate.schemas(
      {
        input: z.string().min(1).meta({default: "I was charged twice."}),
        output: z.object({category: z.enum(["billing", "other"])}),
      },
      function* (message) {
        return {category: message.includes("charged") ? "billing" : "other"} as const;
      },
    ),
  },
});
```

`restate.schemas` needs both `input` and `output`. For a handler without
input, use `z.object({})` or skip schemas and write `*name()`.

## Virtual objects: state per key

An object is addressed by a key (`/ChatSession/bob/ask`). Restate runs
exclusive handlers for one key one at a time, so read-modify-write needs no
locks. State lives in Restate and is available on every call for that key.

```ts
export const counter = restate.object({
  name: "Counter",
  handlers: {
    *add(delta: number) {
      const current = (yield* restate.state().get<number>("count")) ?? 0;
      restate.state().set("count", current + delta); // sync: no yield
      return current + delta;
    },
    *get() {
      return (yield* restate.sharedState().get<number>("count")) ?? 0;
    },
    *reset() {
      restate.state().clearAll();
    },
  },
  options: {handlers: {get: {shared: true}}},
});
```

- `get` and `keys()` return a Future, so `yield*` them. `set`, `clear`, and
  `clearAll` are synchronous.
- **Shared handlers** (`shared: true`) run while an exclusive handler holds the
  key. They can read state and send signals, but cannot write state. Use them
  for `status`, `history`, `approve`, and `interrupt` endpoints next to a
  long-running exclusive handler.
- `restate.handlerRequest().key` is the current key and
  `restate.handlerRequest().id` the current invocation ID.

## Workflows

A workflow is an object whose `run` handler executes exactly once per key
(the workflow ID). Its other handlers are shared and can interact with the
running `run`. See `waiting-and-signals.md` for durable promises.

```ts
export const onboarding = restate.workflow({
  name: "Onboarding",
  handlers: {
    *run(email: string) {
      yield* restate.run(() => createAccount(email), {name: "create account"});
      restate.state().set("stage", "created");
      return "done";
    },
    *stage() {
      return yield* restate.sharedState().get<string>("stage");
    },
  },
});
```

## Handler options

`options` sets service-level options, and `options.handlers` sets per-handler
options: `shared`, `retryPolicy`, timeouts, `enableLazyState`, and others.
Use `retryPolicy` with `onMaxAttempts: "kill"` or `"pause"` to decide what
happens to an invocation after retries are exhausted.

## Serving

```ts
import {serve} from "@restatedev/restate-sdk";

await serve({services: [pricing, triage, counter, onboarding], port: 9080});
```

Register the endpoint once, and again after changing handler signatures:
`npx @restatedev/restate deployments register http://localhost:9080`.
