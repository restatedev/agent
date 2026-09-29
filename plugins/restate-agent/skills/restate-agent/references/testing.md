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

## Test turn behavior

Turn tests stub the model instead of calling a provider. Replace a method on
`modelProvider` (`src/model/provider.ts`) for the test and restore it in a
`finally`, as `test/turn-compaction.test.mjs` does with `summarizeTurn`. For
whole turns, `test/model-failure-turn.test.mjs` builds a turn state and
drives the loop. For handler contracts and routing, see
`test/protocol.test.mjs`.

## Validate

Before claiming a change works, run from the repository root:

```sh
pnpm lint        # oxlint + oxfmt check (pnpm format fixes)
pnpm build       # tsc for the workspace + production Next.js build
pnpm test        # core and web suites
pnpm bundle      # the deployable ESM bundle; catches import problems
git diff --check
```

Then try it end to end: follow the README quickstart with a Restate server
(`RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true`), `pnpm dev:service`, and
`restate deployments register http://localhost:9080`. Call ingress, or start
the optional UI with `pnpm dev:ui` and open http://127.0.0.1:3000/?agent=demo. Inspect
the turn's journal in the Restate UI at http://localhost:9070; it shows each
model call, tool call, and wait.

`pnpm --filter @restate-agents/core test:restart` kills a real endpoint
mid-turn against a disposable Restate server and checks the resumed result.
Run it after changing the order of steps in a turn or in PTC.
