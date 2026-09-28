# Durable agents on Restate

A reference implementation of an LLM agent built on
[Restate](https://restate.dev). It covers what a modern agent harness is
expected to do (context management, parallel and programmatic tool calls,
steering, guardrails, sub-agents) and makes every piece of it durable: every
model call, tool call, wait and message is recorded, so a crash or restart in
the middle of a turn picks up where it stopped.

The code is written to be read.

## Agent features

**Context management**

- **Compaction.** Long conversations are summarized in the background into a
  checkpoint that later turns build on. The most recent exchanges stay out of
  the summary, so the model always sees them verbatim. The conversation log
  itself is never rewritten, and compaction does not block a running turn.
- **Tool search.** Built-in tools are always visible. MCP and discovered tools
  are loaded on demand through `searchTools`, so large catalogs do not fill the
  context window.
- **Programmatic tool calls (PTC).** For work that needs many calls, the model
  writes a small JavaScript program that calls tools, branches on their results
  and returns only a compact answer. It runs in a sandboxed QuickJS guest, and
  every call it makes passes the same guardrails as a direct call.

**Steering and control**

- **Queue, steer or interrupt.** A message sent while the agent is busy is
  queued for the next turn, steered into the running turn, or used to
  interrupt it. Steering never cancels work that is already running, and an
  interrupt ends with a short summary of what was completed.
- **Background operations.** Slow tools such as timers, approvals, sub-agent
  tasks and long programs keep running across model steps. The model can wait
  for them, carry on meanwhile, or cancel one selectively.

**Tool execution**

- **Parallel tool calls.** All tool calls in one model response run
  concurrently. A failing call is reported to the model and does not discard
  the results of the others.
- **Extensible catalog.** Beyond the built-ins, the agent can use tools from
  MCP servers and any Restate handler published with `restate.dev/agent`
  metadata.
- **Output recovery.** A truncated model response gets one retry with a larger
  output budget instead of failing the turn.

**Safety**

- **Guardrails.** A separate policy model checks each proposed answer or tool
  batch against the agent's rules before it is published or run.
- **Human approval.** Rules can require approval; the turn waits for a person,
  durably, for as long as it takes.

**Capabilities**

- **Memory.** Each agent keeps an index of memories, an ID and a short
  description each. The model searches the index, reads the memories it needs
  and decides what to store, so context does not grow with the number of
  memories. This is a simple illustration, not a full memory system.
- **Sub-agents** that the agent creates, delegates to and follows up with.
- **Schedules** that deliver a message to the agent later, once or repeatedly.
- **A sandbox** (a local directory or [Modal](https://modal.com)) for files and
  shell commands, suspended between turns.
- **Web search.**

## Runtime properties

- **Resilient.** A turn is one durable invocation. After a crash or deploy,
  Restate replays its journal: recorded model responses and tool results are
  reused, so the model is never asked to repeat a decision it already made.
- **Long-lived.** Waiting is durable. A turn can sleep, wait for approval or
  wait for a sub-agent for hours or days, and a suspended turn holds no
  process resources while it waits.
- **Responsive.** The controller never waits for the turn, so `ask`, `steer`
  and `interrupt` always answer right away. Model calls and tools run
  in-process inside the turn rather than hopping between services, and
  consumers learn about changes by long-polling rather than repeated polling.
- **Concurrent, in-process durable execution.** Parallel tools and background
  operations are durable tasks spawned and joined inside one turn. Their
  completion order is journaled, so even `Promise.race` in a generated
  program replays deterministically.
- **Consistent without locks.** Each agent's state has a single owner that
  handles its updates one at a time, so routing decisions never race. There
  is no separate database, queue or scheduler: state, messages, timers and
  notifications all live in Restate.
- **Scalable.** Every agent is a key, so an idle agent costs only its stored
  state. The service process is stateless and scales out horizontally, and it
  also builds into a single bundle for serverless deployment.
- **Observable.** Each turn's journal in the Restate UI shows every model
  request, tool input and result, signal and retry.

Replay does not make external side effects exactly-once: a crash between an
MCP call completing and its result being recorded can repeat that call.

## How it is layered

![Layers: agent features built on a durable agent runtime of two Virtual
Objects, on top of Restate](docs/images/layers.svg)

Each agent is two Restate Virtual Objects with the same key:

- **`Agent`** is the controller. It decides what happens to each incoming
  message and owns the agent's profile: instructions, guardrails, memories,
  tool grants, pending approvals, schedules and child agents. Its handlers are
  short, so it always responds, even while a turn runs for minutes.
- **`AgentSession`** runs the turn. One `doTurn` invocation is one turn, and
  its invocation ID is the `turnId`. It owns the append-only conversation log
  and the model/tool loop.

Every agent feature is ordinary code on top of these two objects: tools, the
sandbox lifecycle and model calls are journaled steps inside the turn.

### One message, end to end

1. `Agent.ask` starts a turn if the agent is idle, or queues the message if a
   turn is running (`agent/turns.ts`).
2. Starting a turn snapshots the profile and sends `AgentSession.doTurn` one
   way. The controller records the invocation ID and returns immediately.
3. `doTurn` appends the new messages to the log and builds model context from
   the latest summary plus the rest of the conversation (`session/service.ts`).
4. Each step asks the model for a proposal, checks it against the guardrails,
   then runs the allowed tool calls in parallel or publishes the reply
   (`session/step.ts`). Every model response and tool result is journaled.
5. The turn reports its outcome to `Agent.onTurnEnd`, which retires it and
   starts the next turn if messages were queued meanwhile.

`steer`, `interrupt` and approval decisions reach the running turn as durable
signals addressed to its invocation ID, so they cannot land in the wrong turn.

## Quickstart

You need Node.js 22+, pnpm, the Restate server and CLI, and an OpenAI API key.

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Start Restate in its own terminal, with the SDK features this example uses:

   ```sh
   RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true restate-server
   ```

3. Start the agent service on port 9080 and register it with Restate:

   ```sh
   export OPENAI_API_KEY=your-api-key
   pnpm dev:service
   restate deployments register http://localhost:9080
   ```

4. Talk to an agent through Restate ingress on port 8080. Any agent ID works;
   the first message creates the agent.

   ```sh
   # Start a turn (or queue the message if one is running)
   curl localhost:8080/Agent/demo/ask --json '{"message":"What is the weather in Berlin?"}'

   # Redirect the running turn without cancelling its tools
   curl localhost:8080/Agent/demo/steer --json '{"message":"Use Fahrenheit"}'

   # Stop it, optionally queueing a replacement request
   curl localhost:8080/Agent/demo/interrupt --json '{"reason":"Changed my mind"}'

   # Read the conversation log
   curl localhost:8080/AgentSession/demo/history --json '{"fromSequence":1,"limit":100}'

   # Handlers without input take an empty body and no JSON content type
   curl -X POST localhost:8080/Agent/demo/profile
   ```

The repository also has a small reference conversation UI. It is an example
client, not part of the runtime: start it with `pnpm dev:ui` and open
[http://127.0.0.1:3000/?agent=demo](http://127.0.0.1:3000/?agent=demo).

## What to explore

| Feature | Try it | Start reading |
| --- | --- | --- |
| Queue, steer, interrupt | Send messages while a long turn runs ("sleep for 4 minutes") | `agent/active-turn.ts` |
| Crash recovery | Kill `pnpm dev:service` mid-turn and restart it | `session/service.ts`, `session/step.ts` |
| Guardrails and approvals | Add a guardrail; ask for something it blocks | `session/guardrails.ts`, `agent/approvals.ts` |
| Memory | Ask the agent to remember a preference, then refer to it in a later turn | `agent/memories.ts` |
| Sub-agents | Ask it to delegate research to a helper | `agent/sub-agents.ts`, `session/tools/sub-agents.ts` |
| Schedules | "Remind me in 2 minutes to check the weather" | `agent/schedules.ts` |
| Programmatic tool calls | Ask for work that needs many tool calls; the model writes a QuickJS program | `ptc/runtime.ts` |
| Tool search | MCP and dynamic tools load on demand through `searchTools` | `session/tool-search.ts` |
| Sandbox | Ask it to write and run a script | `sandbox/turn.ts` |
| Compaction | Long conversations are summarized without rewriting the log | `session/history.ts`, `model/compactor.ts` |

Paths are relative to `packages/libs/core/src`.

The built-in tools are weather (a demo stub), web search, sleep, human
approval, cancelling a pending operation, memory, sub-agents, schedules,
sandbox files and commands, tool search, and `executeProgram`. Any Restate
handler published with the `restate.dev/agent: <tool-name>` metadata becomes
a tool too (`session/dynamic-tools.ts`).

## Configuration

The agent service (`packages/libs/core`):

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Required for model calls |
| `MCP_SERVERS_JSON` | MCP servers the agents may use; see below |
| `SANDBOX_PROVIDER` | `local` (default) or `modal`, which also needs `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` |
| `MODAL_APP_NAME`, `MODAL_SANDBOX_NAMESPACE`, `MODAL_SANDBOX_IMAGE`, `MODAL_SANDBOX_TIMEOUT_MS` | Optional Modal settings; see [sandboxes](docs/sandboxes.md) |
| `AGENT_PTC_ENABLED` | Set to `false` to hide `executeProgram` |
| `AGENT_MODEL_MAX_OUTPUT_TOKENS` | Output budget per model call, 1024–64000 (default 32000) |
| `RESTATE_ADMIN_URL`, `RESTATE_ADMIN_TOKEN` | Admin API used to discover dynamic tools |

The reference UI (`packages/apps/web`, see [`env.example`](packages/apps/web/env.example)):

| Variable | Purpose |
| --- | --- |
| `RESTATE_INGRESS_URL` | Restate ingress for the UI server (default `http://localhost:8080`) |
| `RESTATE_AUTH_TOKEN` | Bearer token for an authenticated ingress |
| `APP_PUBLIC_URL` | Browser origin when the UI sits behind a proxy; its host becomes the only accepted Host |
| `APP_ALLOWED_HOSTS` | Comma-separated extra Host values to accept, for proxies that rewrite Host |

### MCP servers

MCP servers are configured by the operator on the agent service, not by
agents or clients. Clients can only switch configured servers on or off per
agent.

```sh
export MCP_SERVERS_JSON='[{"id":"example","type":"http","url":"https://mcp.example.com/mcp","protocol":"stateful","tokenEnv":"EXAMPLE_MCP_TOKEN"}]'
export EXAMPLE_MCP_TOKEN=your-server-token
```

- `protocol` is `stateless` for 2026-07-28 servers or `stateful` for
  2025-era Streamable HTTP servers.
- `tokenEnv` names the environment variable holding a bearer token and must
  end in `_MCP_TOKEN`. Omit it for public servers.
- The token is read only inside the HTTP call. It never enters handler
  inputs, state or the journal. The URL and variable name are not secret.
- Tool results are recorded and shown to the model, so only configure
  servers you trust.

[MCP configuration](docs/mcp-configuration.md) covers rotation and failures.

## Development

```sh
pnpm lint                                  # oxlint + oxfmt check
pnpm build                                 # TypeScript 7 type-check and build, incl. Next.js
pnpm test                                  # core and web test suites
pnpm bundle                                # single-file core bundle
```

The tests run real handlers against recorded journals and fakes; they need no
Restate server or API key. See [development](docs/development.md) for
debugging. `docker/` holds runnable Dockerfiles for the service and the UI.

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/libs/core` | The durable runtime: agent, session, scheduler, sandbox, model calls |
| `packages/libs/types` | Zod wire schemas and Restate service contracts |
| `packages/libs/client` | Typed ingress client for one agent |
| `packages/apps/web` | Reference conversation UI (Next.js), an example client |
| `docs` | Design documentation |

[PROJECT.md](PROJECT.md) gives a file-by-file reading order.

## Further reading

1. [Architecture](docs/architecture.md): state owners, one request, notifications
2. [Protocol](docs/protocol.md): every handler, ordering rules, clients
3. [Turn runtime](docs/turn-runtime.md): steps, guardrails, pending work, recovery
4. [Tools](docs/tools.md): built-ins, programmatic tool calls, dynamic tools, MCP
5. [Schedules](docs/schedules.md) and [sandboxes](docs/sandboxes.md)
6. [Agent guide](docs/agent-guide.md): read before changing runtime semantics

[The documentation index](docs/README.md) has the full list.
