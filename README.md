# A reference for building agentic systems

Productionizing agents is notoriously difficult, because of their long-running, stateful nature.
This reference architecture shows you the simplest way to build **durable, stateful,
steerable, concurrent agents and agentic systems**.

The architecture fully runs on Restate and your favorite container platform or
serverless provider. Restate is a durable runtime for agents that gives you
all the building blocks you need to build advanced, large-scale agentic systems without
managing a large infra stack.

## Core idea

Each agent execution is a durable async process that is:

- **Steerable**: Each execution has a handle that is stable across process
  restarts and can be used to steer it, interrupt it, or approve an action.
  Interrupts automatically propagate through subagents.
- **Stateful**: Execution is isolated per agent session and stateful. Transcripts
  and model context (preferences, instructions) are stored in Restate's
  embedded KV store.
- **Recoverable**: Restate automatically keeps a journal per agent execution,
  to recover it automatically after a failure.
- **Concurrent**: Agents can spawn parallel subagents and tools. Tools execute
  as durable concurrent tasks within the process and can share resources like
  sandbox connections. Subagents run as separate durable invocations with their
  own state and resources.
- **Scalable**: Agents can scale up to thousands of concurrent executions, with
  protection against concurrency issues and race conditions.
- **Pausable**: When an execution needs to wait, it scales to zero. Restate
  persists the timers, approval promises, or subagent invocations, and lets
  the execution resume when the waiting is over.

**Implementing these characteristics in a production-grade manner is
challenging and usually requires a lot of infra and coordination logic. In this
reference architecture, the agent processes rely on Restate to handle this complexity**:

[![Chat, Restate's durable building blocks, and agent processes connected to models, sandboxes, and MCP](docs/images/agent-architecture.png)](docs/images/agent-architecture.svg)

## What this reference includes

This is a runnable TypeScript implementation with an agent runtime, a typed
client, and an optional conversation UI. You can use it as a starting point
for your own application or take individual patterns into an existing agent.
The reference focuses on agent execution and session management. User accounts,
OAuth flows, and evals are not included.

## Features

| Feature | What you can do                                                                                                                    |
| --- |------------------------------------------------------------------------------------------------------------------------------------|
| **[Queueing, steering, and interruption](docs/turn-runtime.md#steering)** | Queue a new request, add instructions to an ongoing execution, or interrupt it and optionally start a replacement.                 |
| **[Parallel tools](docs/turn-runtime.md#agent-loop-iterations)** | Run independent tool calls concurrently and return their results or errors to the model.                                           |
| **[Background operations](docs/tools.md#pending-tools)** | Keep working while timers, approvals, or delegated tasks are pending; wait for or cancel them later.                               |
| **[Subagents](docs/tools.md#sub-agents)** | Delegate work to persistent agents with their own history, memory, and sandbox, then send follow-up tasks to the same agents.      |
| **[Guardrails](docs/turn-runtime.md#guardrails)** | Define guardrails that guard against dangerous or unwanted tool behavior.                                                          |
| **[Human approval](docs/protocol.md#context-and-approvals)** | Ask for a decision and wait durably, while the agent remains steerable and interruptible.                                          |
| **[Programmatic tool calling](docs/tools.md#programmatic-tool-calling-ptc)** | Let the model write JavaScript that combines tool calls and returns a result without putting all intermediate data in its context. |
| **[Tool search](docs/tools.md#turn-local-tool-search)** | Find tools from MCP servers and Restate services, loading their schemas into model context only when needed.                       |
| **[Memory](docs/architecture.md#context-and-delegation)** | Store information across turns, search memory descriptions, and retrieve the entries relevant to the task.                         |
| **[Compaction](docs/architecture.md#control-and-history)** | Summarize older conversation history in the background and compact long-running turns, while keeping recent context verbatim.      |
| **[Schedules](docs/schedules.md)** | Schedule one-off or recurring messages, with a policy to queue, steer, or interrupt when the agent is busy.                        |
| **[Sandboxes](docs/sandboxes.md)** | Read and write files and run commands in a local workspace or Modal sandbox, keeping files between turns.                          |
| **[Client updates](docs/protocol.md#history-and-notifications)** | Follow a running agent, reconnect after a connection failure, and read new history from an offset.                                 |
| **[Extensible tools](docs/tools.md)** | Add built-in tools, connect MCP servers, or expose Restate handlers as tools.                                                      |
| **[Output recovery](docs/turn-runtime.md#model-output-budgets-and-recovery)** | Retry a truncated model response once with a larger output budget, capped by the runtime.                                          |

## Architecture

Each agent has two Restate Virtual Objects with the same `agentId`:
[`Agent`](packages/libs/core/src/agent/service.ts) accepts input and tracks queued
work; [`AgentSession`](packages/libs/core/src/session/service.ts) stores the
conversation and runs each turn in `doTurn`. Both have persistent state and
serialized writes. The controller stays responsive while the session works,
without you managing locks or a separate message queue.

![Two Virtual Objects share the same agentId: Agent accepts input and starts or signals AgentSession, which runs the turn and reports its outcome](docs/images/agent-objects.svg)

### Steering and interruption via durable signals

`Agent` starts a turn, stores its `turnId`, and uses it to send durable signals.
Steering adds input to the next LLM call; interruption stops unfinished work,
including subagent tasks. These controls survive process restarts. The controller
also handles messages that arrive as a turn finishes, so late input isn't lost.
See [steering](docs/turn-runtime.md#steering) and
[interruption](docs/turn-runtime.md#interruption-and-stopping).

![Client, Agent, and AgentSession in three columns, with events read from top to bottom: starting a turn, steering while tools continue, interrupting unfinished work, and returning a summary](docs/images/agent-responsive.svg)

### Fine-grained recovery within the agent loop

Restate records LLM calls, guardrail checks, and durable operations inside tools
separately, with [millisecond-scale overhead](https://restate.dev/vs/temporal).
After a crash, it reuses recorded results and resumes unfinished work—even
partway through a tool. You don't need to build checkpoints or a recovery
worker. External writes still need idempotency when a call can succeed before
its result is recorded. See [recovery](docs/turn-runtime.md#execution-shape).

![A doTurn invocation records LLM, guardrail, and tool-step results in Restate; after a crash, it reuses those results and retries the unfinished tool operation](docs/images/agent-step-recovery.svg)

### Parallelizing work within an execution

Tools run concurrently in the same process and share resources such as sandbox
connections. Each tool's durable steps are recorded independently, so recovery
can reuse completed work across the batch. The runtime handles joining results,
waiting, and cancellation. See [parallel tools](docs/turn-runtime.md#agent-loop-iterations)
and [background operations](docs/tools.md#pending-tools).

### Scaling thousands of stateful agents

Agent IDs run in parallel across service instances, while each session runs one
turn at a time. Restate coordinates state access, routes calls, and recovers
work after process failures. You can add instances without building distributed
locks or pinning conversations to a server. See [state ownership](docs/architecture.md#state-ownership).

### Managing and storing messages and context

History, memories, and summaries live in Restate's embedded KV store. Chunked
history and lazy state keep reads small; compaction trims model context while
preserving the full transcript. The summary calls and state updates are durable
too, so persistence and compaction don't need a separate database or recovery
service. See [history and context](docs/architecture.md#control-and-history).

### Waiting months for approval

Approvals wait on durable signals that survive restarts. Other work can continue;
when nothing can progress, Restate suspends the execution and releases the
process. A decision months later resumes it, without keeping a polling worker
alive. Steering and interruption still work while it waits. See
[approvals](docs/protocol.md#context-and-approvals).

![An execution suspends while waiting for approval and resumes when the decision arrives](docs/images/durable-wait.svg)

### Subscribing to session events

The agent runs independently of the browser. The client watches revision counters
and fetches changed data; sequence numbers let it catch up after disconnects
without losing messages. Multiple tabs can follow the same session, and closing
one doesn't stop the work. See [session updates](docs/protocol.md#history-and-notifications)
and the [typed client](packages/libs/client/src/index.ts).

### Other features

[Subagents](docs/tools.md#sub-agents) keep their own conversation and state across
tasks. [Schedules](docs/schedules.md) use durable timers to deliver future
messages. [Memory](docs/architecture.md#context-and-delegation),
[tool search](docs/tools.md#turn-local-tool-search), and
[programmatic calls](docs/tools.md#programmatic-tool-calling-ptc) keep model
context focused as the agent takes on more work.

## Quickstart


To run the reference locally, you need Node.js 22+, pnpm, the Restate server
and CLI, and an OpenAI API key.

Install the dependencies:

```sh
pnpm install
```

Start Restate in one terminal, with the experimental protocol features used
by this implementation enabled:

```sh
RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true restate-server
```

Start the agent service in another terminal:

```sh
export OPENAI_API_KEY=your-api-key
pnpm dev:service
```

Once the service is listening on port 9080, register it with Restate from a
third terminal:

```sh
restate deployments register http://localhost:9080
```

You can now send requests through Restate's ingress on port 8080. Choose an
agent ID, such as `demo`; the first request creates the agent.

```sh
# Start a turn, or queue the message if one is already running
curl localhost:8080/Agent/demo/ask --json '{"message":"What is the weather in Berlin?"}'

# Send a new instruction without stopping the running tools
curl localhost:8080/Agent/demo/steer --json '{"message":"Use Fahrenheit"}'

# Interrupt the current turn
curl localhost:8080/Agent/demo/interrupt --json '{"reason":"Changed my mind"}'

# Read the conversation history
curl localhost:8080/AgentSession/demo/history --json '{"fromSequence":1,"limit":100}'
```

The weather tool returns synthetic data. To use the conversation UI, run
`pnpm dev:ui` and open
[localhost:3000/?agent=demo](http://127.0.0.1:3000/?agent=demo).

To try failure recovery, ask the agent to sleep for four minutes, stop the
agent service, and start it again. Restate recovers the execution and resumes
the wait. Open the [Restate UI](http://localhost:9070) to inspect the invocation
and its journal.

The reference has no user authentication or account isolation layer. Run it
on a trusted network, or add authentication and authorization in your application
before exposing the agent API. The default local sandbox runs commands on the
host; use an isolated sandbox provider for untrusted workloads.

## Adapting the architecture

Start with the parts that define your agent's behavior:

- **Models and instructions:** edit
  [`agent-config.ts`](packages/libs/core/src/agent-config.ts) to choose models,
  set context limits, and select built-in tools.
- **Tools:** add a module with
  [`defineAgentTool`](packages/libs/core/src/tools-api.ts) and register it in the
  configuration. Tools can make durable calls, wait for signals, and share the
  turn's sandbox. For external tools, see [MCP configuration](docs/mcp-configuration.md)
  and [Restate tool discovery](docs/tools.md#dynamically-discovered-restate-tools).
- **Sandboxes:** implement the
  [provider interface](packages/libs/core/src/sandbox/provider.ts) for your
  platform. The turn acquires a sandbox on first use and shares it across tools.
  The Modal provider releases compute at turn end and keeps workspace files in
  a Volume; running processes don't survive between turns.
- **UI and integration:** use the
  [client](packages/libs/client/src/index.ts) from your backend, or adapt the
  [reference UI](packages/apps/web). The UI is an example consumer of the same
  agent API.

For a larger platform, add the application-specific state and policies around
these components. User profiles could own agent directories and credential
references. Shared token budgets need coordination across concurrent agents.
An idle-time policy could keep sandboxes warm between turns. These are extension
points, rather than features included in this reference.

[PROJECT.md](PROJECT.md) gives a reading order through the code.
[Development](docs/development.md) covers builds and tests, and the
[agent guide](docs/agent-guide.md) explains the execution rules to preserve
when making changes.

## Further reading

The [documentation index](docs/README.md) links to the full implementation docs:

- [Architecture](docs/architecture.md) and [protocol](docs/protocol.md): state
  ownership, API handlers, message ordering, and client updates.
- [Turn runtime](docs/turn-runtime.md) and [tools](docs/tools.md): the loop,
  concurrency, steering, guardrails, and tool execution.
- [Schedules](docs/schedules.md) and [sandboxes](docs/sandboxes.md): timer and
  resource lifecycles.
- [Configuration](docs/configuration.md) and [MCP configuration](docs/mcp-configuration.md):
  models, environment variables, and external connections.

For more background on the design:

- [A Durable Coding Agent — with Modal and Restate](https://restate.dev/blog/durable-coding-agent-with-restate-and-modal)
- [Agent checkpointing is far from production-grade resiliency](https://restate.dev/blog/why-checkpointing-is-not-production-grade-durable-execution)
- [Updating AI Agents safely in production](https://restate.dev/blog/dealing-with-versioning-in-long-running-agents)

### Skills for coding agents

The [`restate-agent` plugin](plugins/restate-agent) includes a skill for extending
this implementation and one for the generator-based Restate SDK. It also connects
the Restate docs MCP server.

Install the plugin in Claude Code:

```sh
/plugin marketplace add restatedev/agent
/plugin install restate-agent@restate-agent
```

For other coding agents, install the skills with:

```sh
npx skills add restatedev/agent
```
