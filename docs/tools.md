# Tool system

This project has two ways to make a capability available to the model:

1. a built-in tool implemented inside `AgentSession.doTurn`; or
2. an annotated Restate handler discovered at runtime.

Both become serializable `ToolManifest` values for model inference. Their
execution boundaries are intentionally different.

In standard agent terminology this is the **tool-use** or **function-calling**
layer. A model proposes tool actions; validated tool results become
observations in a later agent-loop iteration.

## The shared model contract

The model receives only a tool manifest describing its available action space:

```ts
type ToolManifest = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  strict?: boolean; // defaults to true
};
```

A model response refers back to a tool by name:

```ts
type ToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};
```

`model.ts` reconstructs AI SDK tool declarations from the manifests. It does
not receive tool executors. `agent-tools.ts` owns execution, and `turn-step.ts`
owns batch policy and concurrency.

That separation keeps these decisions explicit:

- the model chooses a tool from a serializable catalog;
- the guardrail model evaluates the complete proposed batch before execution;
- the active `agentStep` starts every allowed foreground call in the batch together;
- Restate journals every operation and its result;
- results are projected back into model messages as observations by
  `agent-tools.ts`.

## Built-in tools

Built-ins live in `packages/libs/core/src/agent-tools.ts`. A definition owns
its name, model-facing description, Zod input schema, validation, durable
behavior, and optional pending completion:

```ts
const exampleTool = defineAgentTool({
  name: "example",
  description: "Explain exactly when the model should call this tool.",
  inputSchema: z.object({
    value: z.string().describe("What this field means."),
  }),
  *run({value}, context): restate.Operation<ToolExecution> {
    // Durable handler code.
    return {status: "succeeded", result: value};
  },
});
```

Add the definition to the `definitions` array. The rest follows from that one
registration:

- `agentTools.names` reserves the name from dynamic discovery;
- `agentTools.manifests()` converts the Zod schema to JSON Schema;
- `agentTools.execute()` validates input and dispatches the call;
- the tool becomes available to every agent run.

Use `.describe()` on fields whose meaning is not obvious. Descriptions are part
of the model contract, not cosmetic documentation.

### Current built-ins

| Tool | Purpose | Execution kind |
| --- | --- | --- |
| `getWeather` | Synthetic weather lookup used to demonstrate parallel calls | Foreground |
| `sleep` | Durable timer | Pending |
| `humanApproval` | Signal-backed human decision | Pending |
| `cancelOperation` | Cancel one pending operation by ID | Foreground control |
| `manageMemory` | Atomically set or delete Agent memories | Foreground Agent RPC |
| `scheduleMessage` | Create or replace an Agent-owned schedule | Foreground Agent RPC |
| `cancelSchedule` | Idempotently cancel a schedule | Foreground Agent RPC |
| `listSchedules` | Read active Agent schedules | Foreground Agent RPC |
| `listFiles` | List an agent sandbox directory | Foreground sandbox operation |
| `readFile` | Read a UTF-8 sandbox file | Foreground sandbox operation |
| `writeFile` | Replace a UTF-8 sandbox file | Foreground sandbox operation |
| `executeCommand` | Run one shell command to completion | Foreground sandbox operation |

## Foreground and pending execution

A built-in `run` method returns one of four outcomes:

```ts
type ToolExecution =
  | {status: "succeeded"; result: string}
  | {status: "failed"; error: string}
  | {status: "pending"; result: Record<string, unknown>}
  | {status: "cancel_requested"; operationId: string; reason: string};
```

### Foreground tools

A foreground tool reaches `succeeded` or `failed` before its step finishes.
All calls proposed in one model response are spawned in parallel, then joined.
One failure is data returned to the model; it does not discard sibling
results.

External side effects belong inside `restate.run` or a Restate RPC. Preserve
`InterruptedError` and `CancelledError` instead of converting them into normal
tool failures, so invocation cancellation can propagate through `doTurn`.

Built-in tools are deliberately local handler code. Do not turn one into a
Restate service merely to fit a generic abstraction.

### Pending tools

A pending tool acknowledges immediately from `run`, then implements `complete`.
The turn runtime starts completion as a task that may survive across loop iterations:

```ts
const waitTool = defineAgentTool({
  // ...
  *run(_input, context) {
    return {
      status: "pending",
      result: {
        operationId: context.toolCallId,
        status: "running",
      },
    };
  },
  *complete(input, context) {
    // Durable timer or signal wait.
    return {status: "succeeded", result: "done"};
  },
});
```

The stable `toolCallId` is also the operation ID. Pending completion becomes a
runtime message in a later model round. A turn cannot finish while pending work
exists unless the model cancels it, the user interrupts, or the invocation is
externally cancelled.

Pending is appropriate only when later model work can proceed independently
while an operation waits. It is not a generic wrapper for a slow call.

### Selective cancellation

`cancelOperation` returns `cancel_requested`; the `doTurn` pending registry,
owns the task and applies that request to a matching pending operation.
Cancellation is represented as a runtime event for the next step. It does not
cancel foreground work or the agent run itself.

Completion and cancellation may race. The settled state is authoritative:
completed work stays completed.

## Tool context

Every built-in receives:

```ts
type AgentToolContext = {
  agentId: string;
  turnId: string;
  sandbox: {
    client(): restate.Operation<SandboxClient>;
  };
};
```

The internal call context also contains `toolCallId`. Use:

- `agentId` for Agent-owned state or resources;
- `turnId` to prove that a mutation belongs to the current active turn;
- `toolCallId` for stable operation identity;
- `sandbox.client()` for a lazy, shared turn lease on the agent's sandbox.

The context intentionally does not expose general orchestration hooks.

## Adding a built-in tool

1. Define it beside the existing tools in `agent-tools.ts`.
2. Give it a unique model-safe name and a precise description.
3. Define the complete Zod object schema. Make nullable fields explicitly
   nullable rather than optional when strict model schemas require every
   property.
4. Return structured tool status rather than throwing ordinary domain errors.
5. Re-throw Restate interruption and SDK cancellation errors.
6. Put non-deterministic external work in `restate.run`, or call another
   Restate handler.
7. Add it to `definitions`.
8. Add or update an eval if it changes conversation semantics.
9. Run `pnpm lint`, `pnpm build`, and `pnpm bundle`.

Before making a tool pending, verify that the model can do useful work before
completion and that the runtime has a meaningful way to report, cancel, and later
incorporate its result.

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

```mermaid
sequenceDiagram
  participant T as AgentSession.doTurn
  participant D as dynamic-tools
  participant C as process-local cache
  participant A as Restate Admin API

  T->>D: discoverAgentTools(builtInNames)
  D->>C: read or refresh catalog
  alt cold or expired
    C->>A: GET /services
    A-->>C: services, handlers, metadata, JSON schemas
  end
  C-->>D: discovered tools
  D-->>T: journaled catalog snapshot
  Note over T: same snapshot is used for inference and execution
```

The Admin API is cluster-global knowledge, so it is not stored behind one hot
Virtual Object key. Each service process maintains a read-through cache:

- successful entries refresh after five minutes;
- a failed refresh with a prior snapshot keeps the last-known-good catalog and
  retries after 30 seconds;
- Admin requests time out after five seconds;
- concurrent cold refreshes are coalesced;
- discovery failure without a prior snapshot degrades to built-ins only.

The selected catalog is returned through `restate.run`. Restate therefore
journals one stable snapshot for the turn. A deployment change cannot make the
model infer against one schema and execute against a different target during
replay.

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

Discovered schemas use `strict: false`, because an arbitrary third-party JSON
Schema may not meet the model provider's stricter function-schema rules.

### Selection and conflicts

- Built-in names always win.
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
- dynamic handlers cannot currently become turn-owned pending operations.

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

Deployers must therefore treat the set of annotated handlers as trusted
cluster configuration. This reference does not implement a tenant allowlist,
per-Agent capability set, or an authorization broker in front of dynamic
calls. A production system should add those controls before discovering
handlers from a cluster shared with untrusted service owners.

## Adding a dynamically discovered tool

1. Deploy a Restate JSON handler to the same cluster.
2. Add `restate.dev/agent: <unique-name>` to its handler metadata.
3. Add concise handler documentation written for the model.
4. Publish an accurate JSON input schema and JSON output.
5. For a keyed service, ensure the model can know the appropriate key.
6. Wait for cache refresh, restart this endpoint, or temporarily lower the
   refresh interval while developing.
7. Start a new turn. Existing turns retain their journaled catalog.
8. Inspect logs for discovery warnings and the Restate invocation tree for the
   generic child call.

Choose a built-in when execution needs access to turn-owned pending tasks,
Agent profile mutations, or the shared sandbox context. Choose discovery when
the capability is already a well-defined Restate handler and should be
deployable independently.

## Guardrails and tools

The agent model proposes a complete batch. The guardrail model evaluates the
proposal against the configured policy set before any member starts and
returns one aggregate decision, referencing one policy when blocked:

- `allow`;
- `deny`; or
- `require_approval`.

Every non-allow candidate is checked by a second policy review call. An
unconfirmed denial or approval requirement becomes `allow`.

An approval applies to the exact proposed batch at that point in the turn.
After steering or a changed proposal, the runtime evaluates again. Guardrails
do not invoke tools themselves; they allow, deny, or pause the agent model's
proposal.

## Transcript and observability

The canonical history records structured tool lifecycle summaries—tool names,
counts, and final statuses—so clients can show useful progress. It deliberately
does not persist raw arguments or results.

Use the Restate invocation tree and journal for:

- exact model input/output;
- raw tool arguments and results;
- retries;
- child invocation IDs;
- signal and cancellation propagation.

Use AgentSession history for the stable user-facing conversation and semantic
execution events.
