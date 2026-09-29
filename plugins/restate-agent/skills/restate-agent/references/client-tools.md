# Let a UI run tools

A client tool is a tool the client runs itself: a browser action in an
AG-UI frontend (CopilotKit's `useFrontendTool`), a form the user fills in, a
file picker. The model sees it like any other tool, and the turn waits for
the client to send the result back. This is an extension pattern, not a
feature of the repository: add it when the agent sits behind a product UI
with actions of its own.

It needs no new Restate machinery. It is the `humanApproval` flow with a
program on the other end instead of a person: the Agent holds the pending
call, and the waiting turn receives the result as a durable signal on its
own invocation.

```
client ──ask({message, clientTools})──▶ Agent ──doTurn(request with tools)──▶ AgentSession
                                                               model calls showBooking
                                Agent ◀── requestClientTool ── run(): pending
                                                               complete(): await signal  ⟵ suspended
client reads clientToolCalls, runs the tool
client ──resolveClientTool(outcome)──▶ Agent ──signal(turnId)──▶ complete() returns; the model continues
```

While the client works, the turn is suspended on the signal: no process,
no open connection. It survives a crash, and a new version of the service
does not disturb it, because the invocation stays on the version it
started on.

## Contracts

In `packages/libs/types/src/index.ts`:

- `ClientToolSchema`: `{name, description, parameters}`, where `parameters`
  is the JSON Schema of the input object. Restrict `name` to
  `^[A-Za-z0-9_-]{1,64}$`.
- `AskRequestSchema` gains `clientTools?: ClientTool[]`.
- `AgentTurnRequestSchema` gains `clientTools` as an **optional** field, so
  turns journaled before the change still parse.
- `ClientToolCallSchema` `{toolCallId, turnId, name}`, and
  `ClientToolResultSchema` `{toolCallId, outcome}`, where the outcome is
  `{status: "succeeded", result}` or `{status: "failed", error}`.
- A `client_tool_request` conversation event `{toolCallId, turnId, name}`.
  Mark it as a derived event in `internal-types.ts`, like
  `approval_request`, so it stays out of model context.
- A `client: true` flag on a tools event's calls, so readers can tell
  client tools apart.

In `services.ts`, add four Agent handlers, mirroring the approval ones:
`requestClientTool` and `cancelClientTool` (internal),
`clientToolCalls` (shared) and `resolveClientTool`.

## The Agent holds the pending calls

Write `agent/client-tools.ts` as a copy of `agent/approvals.ts`:

- a `listState<ClientToolCall>("clientToolCalls")`;
- `requestClientTool` accepts only the active, non-interrupting turn
  (`activeTurn.accepting(turnId)`) and is idempotent for an identical call;
- `resolveClientTool` checks that the call exists and its turn still
  accepts it, removes it, and resolves
  `restate.invocation(turnId).signal(clientToolSignalName(toolCallId))`.
  Addressing the invocation means a late or duplicate result cannot land in
  another turn;
- `clearTurn` from `onTurnEnd`, and `clearAll` from `retire`.

## The tools come with the message

`ask` passes `clientTools` to `startTurn`, which puts them in the turn
request. Only the turn that message starts offers them. A queued message's
turn is started later by whichever turn ends, and runs without them; say so
in the handler's comment.

## A pending tool whose work happens outside Restate

Write `session/client-tools.ts` with the two phases of a pending tool (see
`tools-api.ts`):

- `run` calls `Agent.requestClientTool`, returns `pending` with an
  operation ID, and records the `client_tool_request` event as its
  transcript.
- `complete` awaits `restate.signal<ClientToolOutcome>(name)` and returns
  `succeeded(result)` or `failed(error)`. If the wait is interrupted, it
  sends `cancelClientTool` one way, then rethrows.

Wire it into `session/tools.ts`:

- put the turn's client tools on `AgentToolContext`, and add them to
  `ToolAvailabilityContext`;
- after dynamic and MCP discovery in `executeTurn`, drop any client tool
  that reuses a built-in, dynamic or MCP name. A client tool must never
  shadow one of the agent's own;
- `manifests` adds them with `strict: false` (a client's JSON Schema may not
  satisfy OpenAI's strict mode), and `modelManifests` always shows them,
  even with tool search on;
- `unavailable` allows them without a grant: the client offered them;
- `execute` and `complete` dispatch to them after the built-ins;
- `toolActivity` marks them with `client: true`. Their input must be in the
  tools event whatever its size, because the client needs it to run the
  tool.

Guardrails check client tool calls like any other. Inside an
`executeProgram` program, a nested call completes inline, like every
pending tool.

## The AG-UI adapter

`packages/apps/web/src/server/ag-ui.ts` needs four changes:

- **Offer the tools.** Pass `input.tools` to `ask` as client tools.
- **End the run at the call.** On a `client_tool_request` for the run's
  turn, end the run after checking approvals first. A client that declares
  a `protocolVersion` (AG-UI 1.0) gets the call IDs in
  `outcome.pendingToolCallIds`. Older clients, such as the
  `@ag-ui/client` 0.0.59 CopilotKit bundles, reject that field, so leave
  it out and let them find the unanswered call in the stream.
- **Take the results back.** Tool messages in `messages` whose
  `toolCallId` the Agent holds as pending are results: call
  `resolveClientTool` for each (a message with `error` failed), then follow
  the turn from right after the newest entry the client has.
- **Do not echo the result.** Skip `TOOL_CALL_RESULT` for calls marked
  `client`: the client already holds the result it sent.

## Frontend caveats

For CopilotKit (1.74):

- Its runtime relays AG-UI runs: `CopilotRuntime` from
  `@copilotkit/runtime/v2` with an `HttpAgent` for `/api/ag-ui`, and
  `createCopilotRuntimeHandler` in a Next.js route.
- A frontend tool's handler should return an object. CopilotKit sends it as
  JSON, which its tool cards and Inspector parse.
- AG-UI's client refuses a new message while an interrupt is unanswered,
  but the chat input stays enabled. Lock it while the approval prompt is
  mounted.
- The stop button only closes the stream, and the turn keeps running.
  Pass `onStop` to `CopilotChat` and send an interrupt instead
  (`forwardedProps.mode: "interrupt"`). CopilotKit cannot send a steer
  while a run is in progress; put a steer box outside the chat.

## Tests

- Agent handlers, with `test/state-fixture.mjs`, as in
  `test/approvals.test.mjs`: register once, resolve into a signal on the
  turn, reject a stale turn.
- The tool: `execute` registers and returns pending; a shadowing name is
  not offered; `toolActivity` marks the call.
- The adapter, under the real `@ag-ui/client` `HttpAgent`: the run ends at
  the call with its arguments, the next run's tool message resumes the
  turn, and a batch that mixed an agent tool with a client tool still
  delivers the agent tool's result.
