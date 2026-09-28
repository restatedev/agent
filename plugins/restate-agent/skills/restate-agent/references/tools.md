# Tools

Full guide: `docs/tools.md`. The contract is in
`packages/libs/core/src/tools-api.ts`; its header comment explains how a
tool runs.

## Choose the kind of tool

| The capability | Kind | Where it lives |
| --- | --- | --- |
| Belongs to this agent and finishes in seconds | Built-in foreground tool | `src/tools/*.ts` + `agent-config.ts` |
| Takes long, and the model can do useful work meanwhile | Built-in pending tool | `src/tools/*.ts` + `agent-config.ts` |
| Needs the turn's sandbox, pending tasks or the agent's own state | Built-in tool | `src/tools/*.ts` |
| Already is, or should be, an independently deployed Restate handler | Discovered Restate tool | Any service in the cluster |
| Is offered by a remote MCP server | MCP tool | `MCP_SERVERS_JSON` on the core service |

## A foreground tool

`run` does the work and returns `succeeded` or `failed`. The step waits for
it. Put the side effect in `toolRun`, a journaled `restate.run` that turns
unexpected errors into `failed` and rethrows cancellation:

```ts
// src/tools/stock-price.ts
import {z} from "zod";

import {defineAgentTool, failed, toolRun} from "../tools-api.js";

export const stockPriceTool = defineAgentTool({
  name: "getStockPrice",
  description: "Get the latest price of one stock ticker, in USD.",
  inputSchema: z.object({
    ticker: z.string().regex(/^[A-Z.]{1,8}$/).describe("Ticker symbol, e.g. AAPL."),
  }),
  summary: "Looked up a stock price",
  *run({ticker}) {
    if (ticker === "TEST") return failed("TEST is not a listed ticker");
    return yield* toolRun(
      "getStockPrice",
      async ({signal}) => {
        const response = await fetch(`https://prices.example/v1/${ticker}`, {signal});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return JSON.stringify(await response.json());
      },
      {maxAttempts: 3, initialInterval: 200, maxInterval: 2_000},
    );
  },
});
```

Then add it to `tools` in `src/agent-config.ts`. The order there is the
order the model and the tool picker list it. The UI's tool toggles and the
agent's grants (`permissions.builtin`) pick it up from the catalog; nothing
else needs registering.

- `description` is the contract of one call. `instructions` is guidance on
  when and how to use the tool; it joins the system prompt only in turns
  where the tool is offered. Never put tool guidance in `baseInstructions`.
- `summary` is a fixed activity label for the public transcript. It is not
  a function of the input: tool arguments never enter the transcript.
- `unavailable(context)` returns a reason when the tool's own switch is off
  (see `web-search.ts`). The runtime then hides it and refuses its calls.
- Make every schema property required and use `.nullable()` for optional
  values, because strict model function schemas require every property.
- Return `failed(...)` for what the model can react to. Throw only for what
  it cannot fix. `TerminalError` stops retrying; any other error inside
  `restate.run` is retried by its policy.

## A pending tool

For work that takes longer than a step should wait. `run` starts it and
returns at once; `complete` waits for it as a background task of the turn,
and its result reaches the model as a runtime event before a later step.

```ts
export const sleepTool = defineAgentTool({
  name: "sleep",
  description: "Start a durable timer ...",
  inputSchema: z.object({durationSeconds: z.number().int().min(1).max(300)}),
  *run({durationSeconds}, context) {
    return {
      status: "pending",
      result: {operationId: context.toolCallId, status: "running", durationSeconds},
    };
  },
  *complete({durationSeconds}, context) {
    yield* restate.sleep(durationSeconds * 1_000, `sleep-${context.toolCallId}`);
    return succeeded(`Slept for ${durationSeconds} seconds`);
  },
});
```

- `complete` gets the same input and `toolCallId` as `run`, but no value
  from it. Derive every name (timer, signal, awakeable, idempotency key)
  from the `toolCallId`.
- The turn does not finish while pending work runs. An interrupt, or the
  model's `cancelOperation` with the operation ID, interrupts `complete`, and
  the call ends as `cancelled`.
- Only make a tool pending when the model can do useful work before it
  completes. Inside an `executeProgram` program, a pending call is
  completed inline.

To wait for the outside world, have `run` hand an ID to the other system
(inside `restate.run`), and `complete` wait on a signal named after the call.
`humanApproval` does this: its approval ID is the `toolCallId`.

## The tool context

A tool body receives `ToolCallContext`: `agentId`, `turnId`, `toolCallId`,
`permissions`, `webSearchEnabled`, `sandbox` and, lazily, `toolSearch`.
These are trusted; model input is not. Use `context.sandbox` for the
agent's persistent files and commands (see `tools/sandbox.ts`); the turn
provisions it on first use and suspends it at the end.

## A tool that changes the agent's state

A tool cannot write `Agent` state: the turn runs in `AgentSession`. It calls
an `Agent` handler with its `turnId`, and the handler checks that this is
still the active turn and that it holds the grant (`requireTurnTool`). Wrap
the call in `agentCall` so the handler's expected rejections become
feedback for the model:

```ts
*run(schedule, context) {
  const result = yield* agentCall([403], () =>
    restate
      .client(AgentDefinition, context.agentId)
      .createSchedule({...schedule, turnId: context.turnId}),
  );
  if ("status" in result) return result; // rejected: failed(...)
  ...
}
```

See `tools/schedules.ts` and `tools/memory.ts`, and
`references/agent-handlers.md` for the handler side.

## Discovered Restate tools

Any JSON handler deployed to the same Restate cluster becomes a tool when
its handler metadata names it:

```ts
const Grafana = restate.service({
  name: "Grafana",
  handlers: {
    query: restate.schemas({input: QuerySchema, output: ResultSchema}, function* (input) {
      // ...
    }),
  },
  options: {
    handlers: {
      query: {
        description: "Query Grafana for a metric over a time interval.",
        metadata: {"restate.dev/agent": "query_grafana"},
      },
    },
  },
});
```

- The core service discovers these through the Admin API
  (`RESTATE_ADMIN_URL`) and journals one catalog snapshot per turn.
- The handler description becomes the model-facing description. The input
  schema is nested under `input`, plus `key` for an object or workflow.
- Discovered tools are foreground calls; they cannot be pending.
- Built-in names win conflicts.
- The annotation is a capability grant: the model can call the handler with
  the agent service's authority. Only annotate trusted handlers.

Choose a discovered tool when the capability should deploy and scale on its
own. Choose a built-in when it needs the sandbox, pending tasks or the
agent's own state.

## MCP tools

The operator configures MCP servers on the core service; agents and clients
only switch configured servers on or off:

```sh
export MCP_SERVERS_JSON='[{"id":"docs","type":"http","url":"https://mcp.example.com/mcp","protocol":"stateful","tokenEnv":"DOCS_MCP_TOKEN"}]'
```

- `protocol` is `stateless` (2026-07-28 servers) or `stateful` (2025-era).
- `tokenEnv` must end in `_MCP_TOKEN`. The token is read only inside the
  HTTP call and never enters inputs, state or the journal.
- Never accept MCP URLs or tokens from conversation input.

See `docs/mcp-configuration.md`. For per-user OAuth connections instead of
operator tokens, see `references/app-layer.md`.
