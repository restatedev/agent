# A reference agent architecture

A complete agent, built on [Restate](https://restate.dev). Every feature a
modern agent needs is here as a small module you can read in one sitting,
and Restate keeps each turn running through crashes and days-long waits.

[Features](#features) · [One turn, start to finish](#one-turn-start-to-finish) ·
[How a turn works](#how-a-turn-works) · [Quickstart](#quickstart) ·
[Documentation](docs/README.md)

## Features

<table>
<tr>
<td width="50%"><strong><a href="docs/turn-runtime.md#agent-loop-iterations">Parallel tool calls</a></strong><br>Every call in a model response runs at once; a failure goes back to the model.</td>
<td width="50%"><strong><a href="docs/tools.md#pending-tools">Background operations</a></strong><br>Timers and approvals run on while the model works. It can wait or cancel.</td>
</tr>
<tr>
<td><strong><a href="docs/turn-runtime.md#steering">Steering and interrupts</a></strong><br>Redirect or stop a turn while it runs, without losing finished work.</td>
<td><strong><a href="docs/tools.md#sub-agents">Sub-agents</a></strong><br>Delegate tasks to agents with their own history, sandbox and memory.</td>
</tr>
<tr>
<td><strong><a href="docs/turn-runtime.md#guardrails">Guardrails</a></strong><br>Plain-language rules. A policy model allows, blocks or asks a person.</td>
<td><strong><a href="docs/protocol.md#context-and-approvals">Human approval</a></strong><br>A turn can wait days for a decision, holding no process.</td>
</tr>
<tr>
<td><strong><a href="docs/tools.md#programmatic-tool-calling-ptc">Programmatic tool calls</a></strong><br>The model writes a small program; only its result enters the context.</td>
<td><strong><a href="docs/architecture.md#control-and-history">Compaction</a></strong><br>Long conversations and long turns are summarized, recent steps kept verbatim.</td>
</tr>
<tr>
<td><strong><a href="docs/schedules.md">Schedules</a></strong><br>Messages to the agent later, once or on a recurrence. No cron.</td>
<td><strong><a href="docs/architecture.md#context-and-delegation">Memory</a></strong><br>A searchable index, so context does not grow with the memories.</td>
</tr>
<tr>
<td><strong><a href="docs/tools.md#turn-local-tool-search">Tool search</a></strong><br>MCP and discovered tools load on demand, keeping large catalogs out of context.</td>
<td><strong><a href="docs/sandboxes.md">Sandboxes</a></strong><br>A local directory or <a href="https://modal.com">Modal</a> sandbox for files and commands.</td>
</tr>
<tr>
<td><strong><a href="docs/tools.md#dynamically-discovered-restate-tools">Extensible tools</a></strong><br>One module per tool, plus MCP servers and Restate handlers.</td>
<td><strong><a href="docs/turn-runtime.md#model-output-budgets-and-recovery">Output recovery</a></strong><br>A truncated response gets one retry with a bigger output budget.</td>
</tr>
</table>

## One turn, start to finish

Here is one turn, from the first message to the answer, and what Restate
does for it along the way.

### 1. It calls tools in parallel

The model asks for three tools, the guardrails check them once, and they
run together. Each result is recorded as it lands, and a call that fails
goes back to the model as an error.

![Animation: one model step proposes three tool calls; the guardrails allow
the batch in one check; the calls run concurrently, one fails and is reported
as an error while the others finish; the next model step sees both results
and the error](docs/images/parallel-tool-calls.svg)

### 2. You steer it while it works

A new message does not have to wait for the turn to end. A steer reaches the
next model step without cancelling tools in flight, and an interrupt stops
the turn with a summary of what it did.

![Animation: while a turn runs tools in parallel, the client steers it and the
controller answers at once; an interrupt later cancels the remaining tool and
the turn ends with a summary](docs/images/steer-interrupt.svg)

### 3. It waits a day for your approval

When a guardrail needs a person, the turn suspends: no process, only stored
state. It can wait a day, through new versions of the service, and resumes
where it stopped.

![Animation: a guardrail requires approval; the turn suspends for about a day
while a new service version ships; when a person approves, the turn resumes
and finishes](docs/images/durable-wait.svg)

### 4. It survives a crash

Every model call and tool result is in the turn's journal. If the process
dies, Restate replays the journal: nothing is asked or run twice, and the
turn finishes.

![Animation: a turn journals a model call and three tool results, the process
crashes, and after restart Restate replays the journal, reuses every recorded
result and the turn finishes](docs/images/durable-turn.svg)

## Why Restate

Every feature above gets the same guarantees, because they come from Restate
rather than from each feature:

- **A crash resumes the turn.** Restate replays the turn's journal. Recorded
  model responses and tool results are reused, so the model is never asked
  to repeat a decision and completed tool calls are not re-run.
- **New versions don't break running turns.** Restate keeps each turn on
  the service version it started on; new turns use the new version.
- **Waiting is free.** A turn can wait hours or days for an approval, a timer
  or a sub-agent. While it waits it holds no process, only stored state.
- **Always responsive.** `ask`, `steer` and `interrupt` return right away,
  even while a turn runs for minutes.
- **Nothing else to operate.** State, messages, timers and notifications all
  live in Restate: no database, queue or scheduler of the agent's own. Each
  agent's state has a single owner, so there are no locks. The service is
  stateless: it scales out, or builds into a single bundle for serverless.

**What replay does not do:** make external side effects exactly-once. A crash
between an MCP call completing and its result being recorded can repeat that
call.

## How a turn works

Each agent is two Restate Virtual Objects with the same key:

- **`Agent`**, the controller. It decides what happens to each incoming
  message and owns the profile: instructions, guardrails, memories, tool
  grants, approvals, schedules and child agents. Its handlers are short, so
  it always answers.
- **`AgentSession`**, the turn. One `doTurn` invocation is one turn. It owns
  the append-only conversation log and runs the model/tool loop.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant A as Agent (controller)
  participant S as AgentSession (turn)
  participant M as Model, guardrails, tools

  C->>A: ask("Weather in Berlin?")
  A-)S: doTurn(profile snapshot), one way
  A-->>C: started, turnId
  S->>S: append to log, build context

  S->>M: model step
  M-->>S: proposal: call 3 tools
  S->>M: guardrail check
  par tool calls run concurrently
    S->>M: getWeather
  and
    S->>M: webSearch
  and
    S->>M: runCommand
  end

  C->>A: steer("Use Fahrenheit")
  A-)S: steering signal, addressed to turnId
  Note over S: A crash anywhere here is harmless. Restate replays the journal and reuses every recorded result.

  S->>M: model step, with tool results and steering
  M-->>S: final answer
  S-)A: onTurnEnd(outcome)
  Note over A: Retire the turn. Start the next one if messages were queued.

  C->>A: watch(afterRevision), long poll
  A-->>C: history changed
  C->>S: history(fromSequence)
  S-->>C: new entries
```

The controller keeps track of the currently executing turn. `steer`,
`interrupt` and approval decisions reach the turn as durable signals
addressed to its invocation ID, the `turnId`, so they never land in the
wrong turn.

`doTurn` runs the model calls and tools itself, as in-process function calls.
Each result is appended to the turn's journal over one open, low-latency
stream to Restate. That append is the only persistence a step needs.

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

The plugin also connects the Restate docs MCP server. Claude Code offers to
install it when you open this repository. You can also install it by hand:

```sh
# Claude Code
/plugin marketplace add restatedev/agent
/plugin install restate-agent@restate-agent
# Other coding agents
npx skills add restatedev/agent
```

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
