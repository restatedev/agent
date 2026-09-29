# Testing and validating a change

Guides: `docs/development.md` (stack, smoke test, debugging) and the
record/replay section of the `restate-gen-sdk` skill's
`references/running-and-testing.md`.

The core tests run real handler code against recorded journals and fakes.
They need no Restate server and no API key. Tests live in
`packages/libs/core/test/` and use `node:test`.

## Test a tool

Run the tool's `run` inside a handler with `runHandler`, then replay its
journal. The replay must return the same result without repeating the side
effect:

```js
import assert from "node:assert/strict";
import {test} from "node:test";

import * as durable from "@restatedev/restate-sdk-gen";

import {createAgentToolContext} from "../src/session/tools.ts";
import {getWeatherTool} from "../src/tools/weather.ts";
import {runHandler} from "./harness.mjs";

const permissions = {builtin: {mode: "all"}, dynamic: {mode: "selected", names: []}, mcp: []};
const context = {
  ...createAgentToolContext("agent", "turn", true, permissions),
  toolCallId: "call",
};

test("getWeather journals its lookup and replays the same result", async () => {
  const execute = (ctx) => durable.execute(ctx, getWeatherTool.run({city: "Berlin"}, context));
  const live = await runHandler(execute);
  assert.equal(live.output.status, "succeeded");
  const replay = await runHandler(execute, {replay: live.journal});
  assert.deepEqual(replay.output, live.output); // the random temperature came from the journal
});
```

- Mock HTTP with `t.mock.method(globalThis, "fetch", ...)`, and count calls
  to prove a replay did not repeat one.
- Test the edges the model will hit: invalid input comes back as
  `{status: "failed"}`, provider errors do not leak into the result, and
  cancellation is rethrown.
- For a pending tool, run `complete` the same way.

## Test handlers and turns

- **Agent handlers:** `test/local-agent.test.mjs` runs `Agent` handlers
  against in-memory state (`test/state-fixture.mjs`). It covers routing,
  steering, queue limits, coalescing, memories, schedules and `watch`.
  Approvals, deletion and sub-agents have their own files
  (`test/approvals.test.mjs`, `test/agent-deletion.test.mjs`,
  `test/sub-agent*.test.mjs`).
- **Turn behavior:** turn tests stub the model instead of calling a
  provider. Replace a method on `modelProvider` (`model/provider.ts`) for the
  test and restore it in a `finally`, as `test/turn-compaction.test.mjs`
  does with `summarizeTurn`. For whole turns,
  `test/model-failure-turn.test.mjs` builds a turn state and drives the
  loop.
- **Model providers:** `test/model-provider.test.mjs` stubs `fetch` and
  checks the request each provider sends, with no API key.
- **PTC replay:** `test/protocol.test.mjs` checks that a program's
  completion order survives replay.

`runHandler` in `test/harness.mjs` only records and replays `run` entries.
A handler that sleeps, calls another handler or uses state needs the fakes
in the handler tests above.

## Validate

Before claiming a change works, run from the repository root:

```sh
pnpm lint        # oxlint + oxfmt check (pnpm format fixes)
pnpm build       # tsc for the workspace + production Next.js build
pnpm test        # core, client and web suites
pnpm bundle      # the deployable ESM bundle; catches import problems
git diff --check
```

Then try it end to end:

1. Follow the README quickstart: a Restate server started with
   `RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true`, then `pnpm dev:service`,
   then `restate deployments register http://localhost:9080`.
2. Call ingress, or start the optional UI with `pnpm dev:ui` and open
   http://127.0.0.1:3000/?agent=demo.
3. Inspect the turn's journal in the Restate UI at http://localhost:9070.
   It shows each model call, tool call and wait.

After changing the order of steps in PTC, run
`pnpm --filter @restate-agents/core test:restart`. It kills a real endpoint
in the middle of a program and checks the resumed result. It needs a
disposable Restate server with its admin API on port 19070 and ingress on
18080, able to reach this host at `host.docker.internal:19880`.
