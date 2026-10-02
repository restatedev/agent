# A reference for building agentic systems

> Productionizing agents is notoriously difficult, because of their long-running, stateful nature.
> This reference architecture shows you the simplest way to build **durable, stateful,
> steerable, concurrent agents and agentic systems**.

https://github.com/user-attachments/assets/f2244c8f-5f4a-4a1f-87bd-39c0502f078f

The architecture fully runs on Restate and your favorite container platform or
serverless provider. Restate is a durable runtime for agents that gives you
all the building blocks you need to build advanced, large-scale agentic systems without
managing a large infra stack.

## Core idea

Each agent execution is a durable async process that is:

- **STEERABLE**: Each execution has a handle that is stable across process
  restarts and can be used to steer it, interrupt it, or approve an action.
  Interrupts automatically propagate through subagents.
- **STATEFUL**: Execution is isolated per agent session and stateful. Transcripts
  and model context (preferences, instructions) are stored in Restate's
  embedded KV store.
- **RECOVERABLE**: Restate automatically keeps a journal per agent execution,
  to recover it automatically after a failure.
- **CONCURRENT**: Agents can spawn parallel subagents and tools. Tools execute
  as durable concurrent tasks within the process and can share resources like
  sandbox connections. Subagents run as separate durable invocations with their
  own state and resources.
- **SCALABLE**: Agents can scale up to thousands of concurrent executions, with
  protection against concurrency issues and race conditions.
- **PAUSABLE**: When an execution needs to wait, it scales to zero. Restate
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

Each agent has two Restate Virtual Objects (stateful entities addressed by key) keyed by the same `agentId`:

- **[`Agent`](packages/libs/core/src/agent/service.ts)** handles incoming messages
  and tracks the active turn, queued input, profile, memories, approvals, and schedules.
- **[`AgentSession`](packages/libs/core/src/session/service.ts)** stores the
  conversation and runs the model/tool loop. Each `doTurn` invocation handles
  one request within a conversation.

![Two Virtual Objects share the same agentId: Agent accepts input and starts or signals AgentSession, which runs the turn and reports its outcome](docs/images/agent-objects.svg)

This architecture makes the following advanced features possible:

### Steer and interrupt ongoing agent executions

When an `Agent` starts a turn, it gets the `turnId` back, with which it can:
- **Steer the turn**: adds an instruction to the context for the next LLM call.
  Tools already running can finish.
- **Interrupt the turn**: stops unfinished work, including subagent tasks, and asks
  the model to summarize what it completed.

The implementation relies on Restate's durable signals, instead of plumbing together
event queues and state machines.

![Client, Agent, and AgentSession in three columns, with events read from top to bottom: starting a turn, steering while tools continue, interrupting unfinished work, and returning a summary](docs/images/agent-responsive.svg)

See [steering](docs/turn-runtime.md#steering) and
[interruption](docs/turn-runtime.md#interruption-and-stopping).

### Fine-grained recovery within the agent loop

Each step in an agent loop is recorded in Restate's journal: LLM calls, guardrail
checks, tool calls, state updates, approvals,... 
After a failure or a long wait, the agent process can recover to the exact step
where it left off, by replaying the journal.

Restate only adds a few milliseconds of overhead to persist a journal entry,
making fine-grained recovery feasible.

![A doTurn invocation records LLM, guardrail, and tool-step results in Restate; after a crash, it reuses those results and retries the unfinished tool operation](docs/images/durable-turn.svg)

### Resilient parallel work within an execution

Tools run concurrently in the same process and share resources such as sandbox
connections. Each tool's durable steps are recorded independently, so recovery
can reuse completed work across the batch. The runtime handles deterministic
replay during recovery.

![Three tools run concurrently. Restate retries a readFile operation after two
transient failures until its third attempt succeeds. The other calls keep their
completed results, and all three results return to the model.](docs/images/parallel-tool-calls.svg)

See [parallel tools](docs/turn-runtime.md#agent-loop-iterations)
and [background operations](docs/tools.md#pending-tools).

### Scaling thousands of stateful agents

Agent IDs run in parallel across service instances, while each session runs one
turn at a time. Restate coordinates state access, routes calls, and recovers
work after process failures, without the need for locks or coordination. 

See [state ownership](docs/architecture.md#state-ownership).

### Consistent per-session memory and background compaction

This architecture uses Restate's embedded KV store for both conversation state 
and context. Restate gives each agent session its own isolated store, and 
ensures that only a single process can write to it at a time.

This architecture also implements:
- **Selective loading:** history is stored in chunks, and memories are retrieved
  on demand. Clients read only the history they need to update the UI, 
  and the model sees only relevant memories.
- **Compaction background jobs:** Older messages are compacted in the background,
  to avoid exceeding the LLM's context limit. The model sees the latest messages
  verbatim, incl. the last summary. The full chat transcript is retained so the 
  UI client can retrieve it, when needed.

See [history and context](docs/architecture.md#control-and-history).

### Waiting months for approval

When a guardrail needs a person, the turn suspends: no process, only stored state. It can wait weeks, through new versions of the service, and resumes where it stopped.

![An execution suspends while waiting for approval and resumes when the decision arrives](docs/images/durable-wait.svg)

See [approvals](docs/protocol.md#context-and-approvals).

### Subscribing to session updates and reconnecting later

The reference UI uses a [typed client](packages/libs/client/src/index.ts) to read session data and follow
changes to history, approvals, configuration, and schedules. The UI
uses HTTP long-polling and revision tags to fetch only what changed, while
transcript sequence numbers let it catch up after disconnects. 

See [session updates](docs/protocol.md#history-and-notifications).

## Further reading

1. [Architecture](docs/architecture.md): state owners, one request, notifications
2. [Protocol](docs/protocol.md): every handler, ordering rules, clients
3. [Turn runtime](docs/turn-runtime.md): steps, guardrails, pending work, recovery
4. [Tools](docs/tools.md): built-ins, programmatic tool calls, dynamic tools, MCP
5. [Schedules](docs/schedules.md) and [sandboxes](docs/sandboxes.md)
6. [Configuration](docs/configuration.md): models, tools, environment
   variables, MCP servers and the reference UI
7. [Development](docs/development.md): tests, debugging, packaging and the
   repository layout; [PROJECT.md](PROJECT.md) gives a file-by-file reading
   order
8. [Agent guide](docs/agent-guide.md): read before changing runtime semantics
9. [AG-UI](docs/ag-ui.md): connect AG-UI frontends such as CopilotKit

[The documentation index](docs/README.md) has the full list.

### Skills for coding agents

[`plugins/restate-agent`](plugins/restate-agent) has two skills:
- `restate-agent`: how to extend this agent. It covers tools, handlers,
  configuration and testing, and how to grow the agent into a full
  application with users, sessions and credentials.
- `restate-gen-sdk`: how to write the generator-SDK code the agent is built
  from.

The plugin bundles both skills and the Restate docs MCP server. Codex and
Claude Code share the same skill files and MCP configuration.

For Codex, install the plugin from a terminal:

```sh
codex plugin marketplace add restatedev/agent
codex plugin add restate-agent@restate-agent
```

Start a new Codex chat after installation. Opening the repository alone does
not enable the plugin. To install from a local checkout, run
`codex plugin marketplace add .` from the repository root instead of the
first command above. Codex supports the existing
[marketplace catalog](.claude-plugin/marketplace.json) and uses the
[Codex manifest](plugins/restate-agent/.codex-plugin/plugin.json) to load the
skills and MCP server.

Claude Code offers to install the plugin when you open this repository.
You can also install it by hand:

```sh
/plugin marketplace add restatedev/agent
/plugin install restate-agent@restate-agent
```

For other coding agents, install just the skills with
`npx skills add restatedev/agent`. That command does not configure the
Restate docs MCP server.

## Quickstart

You need Node.js 22+, pnpm, the Restate server and CLI, and an OpenAI API key.
The agent can also run on Anthropic, Google, xAI or DeepSeek models, or on
open models through Ollama, vLLM or any OpenAI-compatible server; see
[models](docs/configuration.md#models).

```sh
pnpm install

# Terminal 1: Restate, with the SDK features this example uses
RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true restate-server

# Terminal 2: the agent service on port 9080, registered with Restate
export OPENAI_API_KEY=your-api-key
pnpm dev:service
restate deployments register http://localhost:9080
```

Talk to an agent through Restate ingress on port 8080. Any agent ID works;
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
```

Or chat in the reference UI: run `pnpm dev:ui` and open
[http://127.0.0.1:3000/?agent=demo](http://127.0.0.1:3000/?agent=demo).

**Try this:** ask it to sleep for four minutes, then kill `pnpm dev:service`
and start it again. The turn picks up where it was, and the Restate UI
(`http://localhost:9070`) shows every model call and tool result in the
turn's journal.
