---
name: restate-gen-sdk
description: >
  Build and compose Restate services, virtual objects, and workflows with the
  generator-based TypeScript SDK (@restatedev/restate-sdk-gen): handlers written
  as function* with yield*, durable RPC, fan-out, races, state, timers, signals,
  and awakeables. Use when a project depends on @restatedev/restate-sdk-gen,
  when code uses restate.service / restate.object /
  restate.workflow with generator handlers, or when the user wants to compose a
  larger durable application out of small Restate handlers. Prefer this over
  guidance for the promise-based SDK (ctx.run, ctx.serviceClient) in such projects.
---

# Restate with the generator SDK

Restate records every step of a handler in a journal. After a crash or restart
the handler replays: completed steps return their recorded results and
execution continues from the first unfinished one. The generator SDK expresses
a handler as a `function*`; each durable step is something you `yield*`.

```ts
import {serve} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

export const greeter = restate.service({
  name: "Greeter",
  handlers: {
    *greet(name: string) {
      const id = yield* restate.run(async () => sendWelcomeEmail(name), {name: "send email"});
      return `Hello ${name} (${id})`;
    },
  },
});

await serve({services: [greeter], port: 9080});
```

There is no `ctx` parameter. Operations are free functions on `restate`
(`restate.run`, `restate.state()`, `restate.client(...)`) that find the current
invocation themselves. Do not mix in promise-SDK idioms such as
`ctx.run`, `ctx.serviceClient`, `async` handlers, or `Promise.all`.

## Detect context

1. `package.json` has `@restatedev/restate-sdk-gen` → this skill applies.
   `@restatedev/restate-sdk` is still needed as a peer (for `serve`,
   `TerminalError`, `Opts`, `SendOpts`).
2. The project is the Restate reference agent (`packages/libs/core` with
   `agent-config.ts`) → also load the `restate-agent` skill.
3. Grep for `restate.service(`, `restate.object(`, `restate.workflow(` to find
   existing building blocks before adding new ones.

## Building blocks, in learning order

Introduce concepts one at a time. Each step adds one idea to a working
handler.

| #   | Concept                                          | Core API                                                                              | Reference                               |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | A service handler with a journaled side effect   | `restate.service`, `restate.run`                                                      | `references/handlers-and-state.md`      |
| 2   | Typed, validated input and output                | `restate.schemas({input, output}, fn)`                                                | `references/handlers-and-state.md`      |
| 3   | An entity with durable state, one writer per key | `restate.object`, `restate.state()`                                                   | `references/handlers-and-state.md`      |
| 4   | Readers that run alongside the writer            | `options.handlers.X.shared`, `restate.sharedState()`                                  | `references/handlers-and-state.md`      |
| 5   | Retries, terminal failures, determinism          | `run(..., {retry})`, `TerminalError`, `restate.date()`, `restate.rand()`              | `references/side-effects-and-errors.md` |
| 6   | Call another handler durably                     | `restate.client(def[, key]).handler(input)`                                           | `references/composition.md`             |
| 7   | Fire and forget, or send later                   | `restate.sendClient`, `SendOpts.from({delay})`                                        | `references/composition.md`             |
| 8   | Fan out and join, race, timeouts                 | `restate.all/any/race/allSettled/select`, `restate.spawn`                             | `references/composition.md`             |
| 9   | Wait for the outside world                       | `restate.sleep`, `restate.awakeable`, `restate.signal`, `invocation(id).signal(name)` | `references/waiting-and-signals.md`     |
| 10  | A multi-step process with its own ID             | `restate.workflow`, `restate.workflowPromise`                                         | `references/waiting-and-signals.md`     |
| 11  | Contracts shared between teams or tools          | `restate.iface.*`, `restate.implement`                                                | `references/composition.md`             |
| 12  | Serve, register, call, and test                  | `serve`, `restate deployments register`, `connect`, `RestateTestEnvironment`          | `references/running-and-testing.md`     |

To compose a bigger application, read `references/patterns.md`. It shows how
the blocks above combine into orchestrators, sagas, entities, pub/sub feeds,
and human-in-the-loop flows.

## Choosing a service type

| Need                                                                                          | Use                |
| --------------------------------------------------------------------------------------------- | ------------------ |
| Stateless logic, any number of concurrent calls                                               | `restate.service`  |
| State per key (a user, cart, session, conversation), with calls for one key run one at a time | `restate.object`   |
| A process that runs once per ID, with shared handlers to signal or query it while it runs     | `restate.workflow` |

## Rules to check before finishing

- [ ] Every handler is a generator (`*name()` or `function*`), and every
      `Future` or `Operation` it uses is consumed with `yield*`.
- [ ] All non-deterministic work (HTTP, DB, LLM, time, randomness, UUIDs) goes
      through `restate.run`, or through `restate.date()` / `restate.rand()`.
- [ ] `await` and promises appear only inside a `restate.run(async () => ...)` closure.
      No `restate.*` calls happen inside that closure.
- [ ] Every `restate.run` has a name: `{name: "..."}` or a named function.
- [ ] Concurrency uses `restate.all/any/race/allSettled/select`, never
      `Promise.all`.
- [ ] Spawned tasks are joined, or interrupted and joined, before the handler
      returns; otherwise they are abandoned.
- [ ] Non-retryable failures throw `TerminalError` (from `@restatedev/restate-sdk`).
- [ ] Only exclusive object handlers and a workflow's `run` write state.
      Shared handlers use `restate.sharedState()` and only read. A shared
      handler needs `shared: true` in its options, even when its interface
      uses `iface.shared.*`.
- [ ] No cycles of exclusive calls between objects (A→B→A on the same key deadlocks).
- [ ] The service is registered, called once with curl, and covered by a test
      that replays it (see `references/running-and-testing.md`).

For deployment, server configuration, Kafka, and other operational topics,
query the bundled `restate-docs` MCP server (https://docs.restate.dev/mcp).
