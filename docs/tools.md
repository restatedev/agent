# Tool system

This project has three ways to make a capability available to the model:

1. a built-in tool implemented inside `AgentSession.doTurn`; or
2. an annotated Restate handler discovered at runtime; or
3. a tool from a configured MCP server.

All three become agent SDK (`@restate-agents/core`) `Tool` values in one
per-turn catalog. Their execution boundaries are intentionally different.

The built-in [programmatic tool calling (PTC)](#programmatic-tool-calling-ptc)
tool can compose capabilities from all three sources in one JavaScript program.
It is enabled by default and does not require a separate tool registration.

In standard agent terminology this is the **tool-use** or **function-calling**
layer. A model proposes tool actions; validated tool results become
observations in a later agent-loop iteration.

## The turn catalog

`session/turn-tools.ts` builds the catalog for one turn from the profile
snapshot: the granted built-ins, the permitted Restate handlers and the
permitted tools of each configured MCP server. When two sources claim one
name, the earlier source wins (built-ins, then Restate handlers, then MCP) and
a warning is logged. Discovery is journaled, so inference and execution use
the same snapshot on replay.

The SDK owns the loop mechanics:

- the model chooses a tool from the catalog's names, descriptions and JSON
  schemas; a schema with an exact strict form is sent in strict mode;
- every call's input is validated against its schema before it runs;
- the guardrail hook (`beforeTool`) evaluates each concrete call before it
  starts, including calls a program emits;
- all calls proposed in one model response start together;
- Restate journals every operation and its result;
- results become observations for the next model step.

## Turn-local tool search

`searchTools({query: "github unread notifications"})` performs local full-text
search over the current turn's permitted tool catalog. Built-ins remain visible
upfront; MCP and dynamic Restate schemas are deferred until a search selects
them. Each search returns at most five names and short descriptions, and adds
their complete schemas to the next model request. Loaded schemas remain visible
for the rest of that turn.

The SDK builds the MiniSearch index lazily in memory from the journaled
catalog. It searches names, provider names, descriptions, and parameter names,
splits camelCase/snake_case identifiers, boosts name/provider matches, and pins
exact tool-name matches first. Matching uses prefixes, not fuzzy or semantic
search. A miss should prompt different keywords or a provider name, not a claim
that the user has no connection.

Search selections are journaled; on replay they are restored without
reranking. The index and loaded set are private to the turn. Only permitted
tools are indexed; execution still enforces the same grants and guardrails.
Tool descriptions remain untrusted metadata. Search does not execute matched
tools.

PTC can call every permitted tool, even one whose schema is not yet visible.
Search before writing code for unfamiliar tools: a search inside a program
loads schemas for the next model round, not the running program.

This reduces tool-schema context, not initial discovery/authentication work.
It adds a model round when a deferred tool is first needed.

## Built-in tools

Built-ins live in `packages/libs/core/src/session/tools/`, one module per
family (`local`, `approval`, `sub-agents`, `agent-state`, `sandbox`), and are
registered by model-facing name in `builtins` (`session/tools.ts`). The loop
tools (`searchTools`, `sleep`, `humanApproval`, `cancelOperation`,
`executeProgram`) and `webSearch` come from the SDK. A definition owns its
model-facing description, Zod input schema, fixed transcript label and durable
behavior:

```ts
const example: TurnTool = tool({
  description: "Explain exactly when the model should call this tool.",
  input: z.object({
    value: z.string().describe("What this field means."),
  }),
  describe: {name: "Did the example"},
  *execute({value}, {context}) {
    // Durable handler code; `context` is the TurnContext.
    return value;
  },
});
```

`asyncTool` wraps a tool whose work is one journaled side effect;
`sandboxTool` (`tools/sandbox.ts`) does the same with the turn's sandbox
client. `agentRequest(() => op, codes)` (`errors.ts`) calls into the Agent: a
rejection with one of `codes` becomes a `ToolError` the model sees, and any
other terminal error fails the turn. Throw `ToolError` for a failure the model
should see and act on.

Registering the definition in `builtins` is the only step:

- `names` reserves the name from dynamic discovery;
- `builtinCatalog()` lists it in the tool-permission UI;
- the tool becomes available to agent runs, subject to the grants in the
  turn's profile snapshot.

Use `.describe()` on fields whose meaning is not obvious. Descriptions are part
of the model contract, not cosmetic documentation.

### Current built-ins

| Tool | Purpose | Execution kind |
| --- | --- | --- |
| `searchTools` | Find permitted tools and load their schemas for this turn | Foreground journaled local search |
| `getWeather` | Synthetic weather lookup used to demonstrate parallel calls | Foreground |
| `webSearch` | Tavily keyless web search with bounded source evidence | Foreground journaled HTTP request |
| `sleep` | Durable timer | Background |
| `humanApproval` | Signal-backed human decision | Background |
| `cancelOperation` | Cancel one background operation by ID | Foreground control |
| `manageMemory` | Atomically set or delete agent-local memories | Foreground Agent RPC |
| `createSubAgent` | Create a persistent child and await its optional first task | Durable child-turn wait |
| `messageSubAgent` | Ask a direct child a follow-up and return its answer | Durable child-turn wait |
| `listSubAgents` | Find existing direct children by name, ID and link | Foreground Agent RPC |
| `deleteSubAgent` | Delete a direct child's entire subtree | Foreground Agent RPC |
| `createSchedule` | Create or replace a message timer for this conversation | Foreground Agent RPC (turn-checked) |
| `cancelSchedule` | Idempotently cancel a schedule | Foreground Agent RPC (turn-checked) |
| `listSchedules` | Read schedules for this agent | Foreground Agent RPC |
| `listFiles` | List an agent sandbox directory | Foreground sandbox operation |
| `readFile` | Read a UTF-8 sandbox file | Foreground sandbox operation |
| `writeFile` | Replace a UTF-8 sandbox file | Foreground sandbox operation |
| `executeCommand` | Run one shell command to completion | Foreground sandbox operation |
| `executeProgram` | Coordinate tools in JavaScript and return a compact result | Foreground, with supervised child calls |

## Sub-agents

`createSubAgent` accepts a name, nullable configuration overrides and optional
initial message. It copies parent instructions, memories, guardrails and
current tool grants, then applies narrower access or additional policy. Children
keep separate conversations and sandbox files. Later parent changes do not
rewrite a child's snapshot. Children cannot create children or schedules.

The parent Agent owns the child directory. Creation uses a deterministic child
ID derived from parent ID, turn ID and tool-call ID, so replay does not create
a duplicate. The child stores its parent ID. All coordination validates the
active parent turn and allowed tools.

An initial message starts a durable child turn. The parent session waits for
that exact invocation; its controller stays responsive. `messageSubAgent`
reuses the child's conversation for follow-ups. Different children can run in
parallel, directly or through PTC. A child accepts only one task at a time.
Parent interruption, completion and abandoned PTC branches clean up recorded
child turns; delayed cleanup cannot interrupt a newer follow-up.

`listSubAgents` returns direct children. `deleteSubAgent` retires a direct
child's subtree and separate sandboxes. It preserves the parent's memories and
operator configuration; retained conversation history is not purged. The UI
permits child inspection, interruption and approvals; task input comes from
the parent.

## Web search

`webSearch({query, maxResults})` uses [Tavily keyless access](https://docs.tavily.com/documentation/keyless):
no API key, account, or OAuth setup is needed. It is enabled by default. In the
UI, open **Context → Web search** to enable or disable it for that Agent. The
switch saves immediately to `AgentProfile.webSearchEnabled`, publishes a
`profile` notification, and survives refreshes. Changes apply from the next
turn; an active turn keeps its original profile snapshot.

Disabled turns omit `webSearch` from both the model and PTC catalogs, and the
dispatcher rejects direct attempts to call it. This switch controls only this
built-in tool, not internet access through separately configured MCP tools or
the sandbox.

Both input fields are required: `query` is a non-empty public search query of
up to 1,000 characters, and `maxResults` is an integer from 1 to 10 (normally 5).
The result is `{query, results: [{title, url, snippet}]}`; it contains source
snippets, not full pages or a provider-generated answer. For example:

```js
async tools => {
  const result = await tools.webSearch({
    query: "Restate durable execution documentation",
    maxResults: 3,
  });
  return result.results;
}
```

Queries are sent to Tavily, so the tool instructions prohibit sending secrets
or private conversation data. Results are untrusted evidence, not instructions;
the model is told to cite relevant source URLs. Keyless access is free but
rate-limited, not unlimited. Quota and invalid-response failures are reported
as tool failures, never fabricated empty searches.

The HTTP request is inside `restate.run`; successful journaled results are
reused on replay. It uses basic search, at most two attempts for transient
failures, a 15-second timeout per attempt, and the turn's cancellation signal.
Quota/auth failures are not automatically retried. Responses are capped at
1 MB, titles at 300 characters, and snippets at 1,500 characters per result.
Normal tool guardrails and interruption apply, including calls emitted by PTC.

## Programmatic tool calling (PTC)

PTC reduces intermediate model context: instead of returning every tool response
to the model for the next decision, the model writes a program that calls tools,
branches on their results, and computes a compact answer. It is another tool in
the existing agent loop, the SDK's `programTool`, not a separate agent or a
replacement tool backend.

PTC is enabled by default. Set `AGENT_PTC_ENABLED=false` on the core service to
disable it, for example `AGENT_PTC_ENABLED=false pnpm dev:service`.
Only the exact value `false` disables PTC; leaving the variable unset or setting
it to `true` enables it. Each turn journals the setting when it builds its
catalog (`programsEnabled` in `session/tools.ts`), so an in-flight turn replays
with the setting it started with. When disabled, `executeProgram` is left out
of the turn's catalog and the tool-permission UI (`builtinCatalog`). Its name
stays reserved.

The model can use `executeProgram({source})` to coordinate the same static,
Restate-discovered, and MCP tools that it can call directly. The source evaluates
to an async function accepting `tools`; each function takes the exact input
object described by its model-facing tool schema. PTC itself is excluded from
the guest catalog, so programs cannot recursively start programs.

```js
async tools => {
  const cities = ["Berlin", "Paris", "London"];
  const results = await Promise.allSettled(
    cities.map(city => tools.getWeather({city})),
  );
  return results.map((result, i) => ({
    city: cities[i],
    weather: result.status === "fulfilled" ? result.value : null,
    error: result.status === "rejected" ? result.reason.message : null,
  }));
}
```

`tools["exact-tool-name"]({...})` works for names that are not JavaScript
identifiers. Successful calls return parsed JSON when their result is JSON,
otherwise a string. MCP results retain `content` and `structuredContent` and
the existing attachment filtering. Failed tool outcomes reject promises.
Only the returned JSON or deterministic program error becomes an observation
for the agent model. Child activity and approval events still appear in the
transcript without raw arguments or results.

The tool description explains when to use PTC: dependent
lookups, parallel work, filtering, joins, and aggregation where carrying every
intermediate response through the agent model would waste context. Simple
actions can still use direct calls. Available tool schemas remain in the model's
catalog; this change reduces intermediate result context, not schema context.

### Try it in chat

With the core service running and PTC enabled, no MCP setup is needed for this
built-in-tool example:

> Use executeProgram to look up the demo weather for Berlin, Paris, and London
> in parallel. Return only the warmest city and its temperature, and report any
> failed lookups. Do the comparison in JavaScript, not in another model round.

`getWeather` returns text such as `24°C, sunny in Berlin`, not an object with a
`temp` field. Its synthetic temperature is a random integer from 10 to 40°C;
the tool journals that sample, so replay reuses it. The program can parse the
leading temperature and aggregate the results before returning JSON.

In the UI, expect `executeProgram` and its child `getWeather` activity; inspect
the Restate journal for the generated source and compact return value. The
model still chooses its tools, so enabling PTC does not force every task to use
it. Replacing the example calls with discovered tools uses their exact catalog
names and input schemas, with no separate PTC configuration.

### Durable execution

The SDK runs the program in QuickJS inside an embedded WebAssembly module. Each
execution attempt creates a fresh runtime. The model response already journals
the source, and discovery journals the turn's catalog. Every tool call the
program emits is an ordinary SDK tool call: validated, checked by the guardrail
hook, journaled and reported in the transcript like a direct call. Replay
reconstructs the guest's heap and promises from the recorded completion order,
so native `Promise.race`, `any`, `all`, and `allSettled` work.

### Policy, background tools, and interruption

The PTC wrapper and its JavaScript source are not submitted for policy approval
(`guardToolCall` skips `executeProgram`). Each emitted concrete call goes
through the normal guardrail gate with its actual tool name and input. MCP
authentication and sandbox access use the same turn context as direct calls.

Inside a program, `sleep` and `humanApproval` promises resolve when their
result arrives. Human approval returns its normal decision; the program must
inspect it before taking dependent actions.

If steering arrives while a program is running, the step stops waiting for it.
The program continues as background work: the model receives
`{status: "pending", operationId}` for the `executeProgram` call, reads the
steering, and later receives the program's return value as a runtime message.
`cancelOperation` with that operation ID stops the program.

Returning ends the program and cancels its calls still running; await
`Promise.allSettled` on those branches before returning if they must finish.
Turn interruption also stops the program and its active calls. Cancellation
cannot undo effects that already occurred.

Known program failures (syntax, uncaught rejection, invalid output, or an
exhausted budget) become repairable tool failures. Escaped host/SDK failures
and turn interruption propagate rather than becoming guest rejections or model
feedback.

Programs have no direct I/O, timers, module loader, `Date`, or `Math.random`.
Inputs and results cross as JSON copies. The SDK's defaults bound a program to
128 tool calls, 64,000 source characters, 10,000 interrupt checks per attempt
and 10,000 microtasks per drain.

## Foreground and background execution

### Foreground tools

A foreground tool finishes before its step does. All calls proposed in one
model response start in parallel, then join. A `ToolError` is data returned to
the model; it does not discard sibling results. A `RunFailedError`, or any
other terminal error, fails the turn instead.

There is no central cap on result size. A source that could journal unbounded
data limits it inside its run: web search responses (1 MB), sandbox file reads
and command stdout/stderr (1,000,000 characters each). An MCP result over
128,000 characters fails the call. PTC programs see full results and can
filter them.

External side effects belong inside `restate.run` or a Restate RPC. Let
`CancelledError` propagate instead of converting it into a tool failure, so
invocation cancellation reaches `doTurn`.

Give every side effect an explicit retry policy. A bounded failure is feedback
the model can act on. Operations that are safe to repeat (`listFiles`,
`readFile`, `writeFile`, `getWeather`, `webSearch`) use a small bounded retry.
Operations that are not (`executeCommand`, MCP calls) use `{maxAttempts: 1}`:
a transport error can arrive after the command already ran, and the model can
inspect the result rather than have it silently run again. Crash recovery can
still repeat an effect whose result was not yet journaled.

Built-in tools are deliberately local handler code. Do not turn one into a
Restate service merely to fit a generic abstraction.

### Background tools

A tool marked `background` (the SDK's `sleep` and `humanApproval`) answers its
call at once with `{status: "pending", operationId}` and keeps running while
the model works on. The call ID is the operation ID. Its result later reaches
the model as a user-role runtime message,
`{"source":"agent-runtime","type":"background-tool-result",...}`, and the
system prompt tells the model to treat it as data. A turn cannot finish while
background work is outstanding unless the model cancels it, the user
interrupts, or the invocation is externally cancelled.

Background is appropriate only when later model work can proceed independently
while an operation waits. It is not a generic wrapper for a slow call.

### Selective cancellation

`cancelOperation` cancels one background operation by ID. It does not cancel
foreground work or the turn itself. Completion and cancellation may race; the
settled state is authoritative, and completed work stays completed.

## Tool context

Every tool receives the turn's `TurnContext` (`session/turn-context.ts`):

```ts
type TurnContext = {
  agentId: string;
  turnId: string;
  instructions?: string;
  sandbox: TurnSandbox; // client() and release()
  transcript: Transcript;
  policy: TurnPolicy; // guardrails and the decisions made this turn
};
```

The SDK's tool context adds the call ID and step. Use:

- `agentId` for Agent-owned state or resources;
- `turnId` for Agent-owned state that must be correlated with the current
  active turn, such as memory, approvals and schedules;
- the call ID for stable operation identity;
- `sandbox.client()` for the agent's sandbox, acquired lazily once per turn.

Schedule mutations go through the Agent with the current `turnId`, which
authorizes them against the live turn. Once saved, the schedule is an
independent durable side effect; a later interruption of the creating turn does
not roll it back.

## Adding a built-in tool

1. Define it in the matching `session/tools/*.ts` family and register it in
   `builtins` in `session/tools.ts`.
2. Give it a unique model-safe name, a precise description and a fixed
   `describe` label.
3. Define the complete Zod object schema. Make fields nullable rather than
   optional, so the schema qualifies for strict mode.
4. Throw `ToolError` for failures the model should see, rather than returning
   ad hoc error strings.
5. Let Restate cancellation errors propagate.
6. Put non-deterministic external work in `restate.run` with an explicit
   retry policy (see [Foreground tools](#foreground-tools)), or call another
   Restate handler.
7. Add or update a test if it changes conversation semantics.
8. Run `pnpm lint`, `pnpm build`, and `pnpm bundle`.

Before making a tool background, verify that the model can do useful work
before completion and that the runtime has a meaningful way to report, cancel,
and later incorporate its result.

## Dynamically discovered Restate tools

A deployed JSON Restate handler opts into the dynamic tool registry through
handler metadata:

```text
restate.dev/agent: query_grafana
```

The metadata value is the model-facing tool name. The current implementation
accepts `[A-Za-z0-9_-]{1,64}`.

With the generated TypeScript SDK used by this repository:

```ts
const Grafana = restate.service({
  name: "Grafana",
  handlers: {
    query: restate.schemas(
      {input: QuerySchema, output: QueryResultSchema},
      function* (input) {
        // ...
      },
    ),
  },
  options: {
    handlers: {
      query: {
        description:
          "Query Grafana for a metric over a requested time interval.",
        metadata: {
          "restate.dev/agent": "query_grafana",
        },
      },
    },
  },
});
```

Other Restate SDKs expose the same handler metadata through their own service
definition syntax. The contract that this agent reads is the annotation,
handler documentation, service type, and Admin API JSON input schema.

### Discovery lifecycle

At the start of each turn with dynamic grants, `session/restate-tools.ts`
reads `GET /services` from the Admin API through the SDK's `restateTools`,
inside `restate.run`. Restate therefore journals one stable snapshot for the
turn: a deployment change cannot make the model infer against one schema and
execute against a different target during replay. Transient failures are
retried; a discovery that still fails degrades to no dynamic tools, with a
logged warning. There is no process-local cache, so a newly annotated handler
is visible from the next turn.

Configure discovery with:

```text
RESTATE_ADMIN_URL=http://localhost:9070
RESTATE_ADMIN_TOKEN=<optional bearer token>
```

### Schema mapping

The handler's JSON input schema is nested under `input`:

```json
{
  "input": {
    "query": "rate(http_requests_total[5m])"
  }
}
```

For a Virtual Object or Workflow, the model schema also requires `key`:

```json
{
  "key": "tenant-42",
  "input": {
    "query": "..."
  }
}
```

If a handler has no input schema, `input` is omitted. Local JSON Schema
references are rewritten when the schema is nested. Handler documentation
becomes the model-facing description; otherwise a generated description names
the Restate target.

A discovered schema is sent in strict mode only when it has an exact strict
form; an arbitrary third-party JSON Schema usually does not.

### Selection and conflicts

- Built-in names always win, and are reserved from discovery.
- Targets are sorted by `service/handler` before selection.
- When two annotated handlers claim one name, the first sorted target wins and
  a warning is logged.
- Invalid names are ignored with a warning.
- The name and target are fixed in the turn snapshot.

### Invocation contract

Dynamic tools run as foreground calls through generic `restate.call`:

```ts
yield* restate.call({
  service: target.service,
  method: target.handler,
  key: optionalKey,
  parameter: input,
  inputSerde: restate.serde.json,
  outputSerde: restate.serde.json,
});
```

Consequences:

- the child invocation is durable and visible in the Restate invocation tree;
- keyed handlers require a model-supplied key;
- input and output must use JSON;
- the complete call belongs to the current foreground batch;
- interruption or external cancellation propagates to the child;
- dynamic handlers cannot currently become background operations.

The called handler owns its own idempotency and side-effect semantics in the
normal Restate way.

The current catalog uses the input JSON Schema to guide the model. It does not
yet expose the handler's output schema to the model or validate the returned
value against it. The result must still be JSON-serializable and is converted
to a string for the next model round.

### Trust boundary

The annotation is an opt-in capability, not just documentation. An annotated
handler can be selected by the model and is called with this endpoint's Restate
authority. Its documentation and schema also enter the model prompt.

Treat the annotated handlers as trusted cluster configuration. Per-agent tool
selections narrow the available catalog, but the example has no tenant identity
or separate authorization broker for cluster capabilities.

## Adding a dynamically discovered tool

1. Deploy a Restate JSON handler to the same cluster.
2. Add `restate.dev/agent: <unique-name>` to its handler metadata.
3. Add concise handler documentation written for the model.
4. Publish an accurate JSON input schema and JSON output.
5. For a keyed service, ensure the model can know the appropriate key.
6. Start a new turn. Existing turns retain their journaled catalog.
7. Inspect logs for discovery warnings and the Restate invocation tree for the
   generic child call.

Choose a built-in when execution needs access to turn-owned background work,
Agent profile mutations, or the shared sandbox context. Choose discovery when
the capability is already a well-defined Restate handler and should be
deployable independently.

## MCP tools

MCP servers contribute foreground tools to the same catalog as built-ins
and discovered Restate handlers, through the SDK's `mcpTools`. Configure
endpoints with `MCP_SERVERS_JSON` on the core process; see
[MCP configuration](mcp-configuration.md) for examples, protocol selection and
the environment credential boundary.

Discovery journals a turn-local snapshot of the permitted remote definitions
and, for `stateful`, the session, so a replay reconnects rather than
rediscovering. `stateless` uses handshake-free 2026-07-28 discovery; `stateful`
uses a supported 2025-era initialize handshake. The selected protocol is
explicit.

Model names are `<namespace>_<remoteName>`, where the namespace is the server
ID, or a sanitized prefix and a stable hash when the ID is not a short
identifier; names that are not valid tool names are normalized the same way.
`searchTools` loads permitted external schemas on demand; PTC dispatches
through the same permissions and policy gate.

Each HTTP effect resolves the referenced token immediately before use. A
server that cannot be reached or authorized is reported to the model as
unavailable for the turn, and the rest of the catalog still works. Wherever a
server echoes the token back in a result or error, the SDK redacts it before
the value is journaled. A failed tool call reaches the model with its
(redacted) error message, so the model can correct its input. There are no OAuth signals,
browser authorization actions or refresh-state storage. Stateful connections
are released at turn completion.

Remote `isError` results and failed HTTP effects become tool failures.

MCP calls include a stable `Idempotency-Key` derived from the invocation and
tool-call IDs, but servers must implement deduplication themselves. The port
allows one attempt per call to avoid eager retries. A crash after remote
completion but before recording the result can repeat a side effect. Recorded
successful results replay without another HTTP request.

Catalogs and tool results may contain sensitive data supplied by the remote
server. Token redaction is not a general-purpose response redactor.
Endpoints, remote schemas and descriptions remain a trusted operator choice
and untrusted model input.

## Guardrails and tools

The guardrail model evaluates each concrete call against the configured policy
set before it starts (`guardToolCall` in `session/guardrails.ts`). PTC wrappers
are excluded; their concrete child calls are evaluated as they are emitted. The
gate returns one decision, referencing one policy when not allowing:

- `allow`;
- `deny`; or
- `require_approval`.

Every non-allow candidate is checked by a second policy review call. An
unconfirmed denial or approval requirement becomes `allow`. A denial reaches
the model as the call's failure; it can choose a compliant alternative.

An approval applies to the exact approved action in that turn. After steering,
earlier approvals and rejections are cleared and actions are evaluated again.
Guardrails do not invoke tools themselves; they allow, deny, or pause a call.

## Transcript and observability

The canonical history records structured tool lifecycle summaries (tool names,
counts, and final statuses) so clients can show useful progress. It deliberately
does not persist raw arguments or results. A built-in's activity label is a
fixed `describe` label on its definition (`"Read a file"`, `"Searched tools"`),
not a function of its input, so paths, queries, commands and names cannot
leak into the transcript through a label.

Use the Restate invocation tree and journal for:

- exact model input/output;
- raw tool arguments and results;
- retries;
- child invocation IDs;
- signal and cancellation propagation.

Use AgentSession history for the stable user-facing conversation and semantic
execution events.
