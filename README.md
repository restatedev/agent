# A reference architecture for durable agents

**Steer a running turn. Wait for a person. Pick up after a crash.**

A complete TypeScript agent built on [Restate](https://restate.dev). A small
controller handles incoming messages while a durable turn runs the model and
its tools. Run it locally, explore the implementation, and use the included
coding-agent skills to help adapt it into your application.

[Run it locally](#run-it-locally) · [Make it yours](#make-it-yours) ·
[How it works](#how-it-works) · [Documentation](docs/README.md)

<picture>
  <source media="(prefers-reduced-motion: reduce) and (max-width: 600px)" srcset="docs/images/landing-control-mobile-still.svg">
  <source media="(prefers-reduced-motion: reduce)" srcset="docs/images/landing-control-still.svg">
  <source media="(max-width: 600px)" srcset="docs/images/landing-control-mobile.svg">
  <img src="docs/images/landing-control.svg" alt="A controller acknowledges steering while tools finish. The next model step uses the new direction." width="800">
</picture>

## Run it locally

You need Node.js 22+, pnpm, the Restate server and CLI, and an OpenAI API key.

```sh
pnpm install
```

Start Restate in one terminal:

```sh
RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true restate-server
```

Start the agent service in another:

```sh
export OPENAI_API_KEY=your-api-key
pnpm dev:service
```

In a third terminal, register the running service and start a conversation:

```sh
restate deployments register http://localhost:9080
curl localhost:8080/Agent/demo/ask --json '{"message":"Sleep for four minutes, then tell me you finished."}'
```

For the reference chat UI, run `pnpm dev:ui` and open
[127.0.0.1:3000/?agent=demo](http://127.0.0.1:3000/?agent=demo).

**Try recovery:** while the timer runs, stop the agent service and start it
again. Restate keeps the turn's journal, and the turn resumes.

<details>
<summary>Steer, interrupt, or read the conversation</summary>

```sh
curl localhost:8080/Agent/demo/steer --json '{"message":"Also include the demo weather in Berlin."}'
curl localhost:8080/Agent/demo/interrupt --json '{"reason":"Changed my mind"}'
curl localhost:8080/AgentSession/demo/history --json '{"fromSequence":1,"limit":100}'
```

`ask` starts a turn or queues input. `steer` redirects an active turn without
cancelling its tools. `interrupt` stops unfinished work and finalizes the turn.

</details>

[Configuration](docs/configuration.md) · [Development and troubleshooting](docs/development.md)

## Make it yours

Start with [`agent-config.ts`](packages/libs/core/src/agent-config.ts) to
change models, base instructions, and built-in tools. For larger changes,
the repository includes two skills for your coding agent:

**Extend the agent:** [`restate-agent`](plugins/restate-agent/skills/restate-agent/SKILL.md)
covers tools, handlers, testing, and adding an application layer with users,
sessions, and credentials.

**Build with Restate:** [`restate-gen-sdk`](plugins/restate-agent/skills/restate-gen-sdk/SKILL.md)
covers the generator SDK used by this agent: durable handlers, calls, state,
timers, and signals.

Install the skills for your coding agent:

```sh
npx skills add restatedev/agent
```

<details>
<summary>Claude Code: install the plugin</summary>

Claude Code offers to install the plugin when you open this repository.
The plugin includes both skills and connects the Restate docs MCP server.
To install it manually, run these commands in Claude Code:

```text
/plugin marketplace add restatedev/agent
/plugin install restate-agent@restate-agent
```

</details>

[Extension guide](docs/agent-guide.md) · [Application-layer patterns](plugins/restate-agent/skills/restate-agent/references/app-layer.md)

## How it works

Two Restate Virtual Objects share an agent ID:

| Object | Responsibility |
| --- | --- |
| **Agent** | A responsive controller. Routes messages and owns the profile, memories, approvals, schedules, and child directory. |
| **AgentSession** | Owns the conversation log and sandbox. Each `doTurn` invocation runs one model/tool loop. |

The controller acknowledges input without waiting for the turn. Steering,
interrupts, and approval decisions target the exact running invocation.

### Recorded work survives a restart

Restate records model responses and tool results as the turn runs. After a
crash, replay reuses those recorded results and continues unfinished work.
Timers and approval waits can suspend without holding an execution process.

<picture>
  <source media="(prefers-reduced-motion: reduce) and (max-width: 600px)" srcset="docs/images/landing-recovery-mobile-still.svg">
  <source media="(prefers-reduced-motion: reduce)" srcset="docs/images/landing-recovery-still.svg">
  <source media="(max-width: 600px)" srcset="docs/images/landing-recovery-mobile.svg">
  <img src="docs/images/landing-recovery.svg" alt="The service restarts while recorded model and tool results remain in Restate. The turn reuses them and continues." width="800">
</picture>

External effects can still repeat if a crash happens before their results are
recorded. New code versions can run alongside old deployments; keep the old
endpoint available for its running turns.

[Read the architecture](docs/architecture.md) · [Follow one turn](docs/turn-runtime.md)

### Keep the history. Lighten the context.

Conversation compaction summarizes older exchanges in the background. Recent
exchanges stay verbatim; the conversation log stays append-only.

<picture>
  <source media="(prefers-reduced-motion: reduce) and (max-width: 600px)" srcset="docs/images/landing-context-mobile-still.svg">
  <source media="(prefers-reduced-motion: reduce)" srcset="docs/images/landing-context-still.svg">
  <source media="(max-width: 600px)" srcset="docs/images/landing-context-mobile.svg">
  <img src="docs/images/landing-context.svg" alt="The full conversation log stays intact. Later model calls see a summary of older exchanges plus eight recent exchanges verbatim." width="800">
</picture>

A separate, blocking compaction can shrink a single turn's working context
before it outgrows the model's window.

[Understand the two compactions](docs/turn-runtime.md#working-context-compaction)

## Explore the features

| What you want to understand | Start here |
| --- | --- |
| **Control a running agent** — queue input, steer, interrupt, and follow progress | [Protocol](docs/protocol.md) |
| **Coordinate work** — parallel tool calls, sub-agents, and JavaScript programs in QuickJS | [Tools](docs/tools.md) |
| **Wait and resume** — pending timers, explicit approval tools, cancellation, and schedules | [Turn runtime](docs/turn-runtime.md#foreground-and-pending-tools) · [Schedules](docs/schedules.md) |
| **Gate actions** — natural-language guardrails and human approval of protected proposals | [Guardrails](docs/turn-runtime.md#guardrails) |
| **Manage context** — searchable memories, deferred tool schemas, and compaction | [Memory](docs/architecture.md#context-and-delegation) · [Tool search](docs/tools.md#turn-local-tool-search) |
| **Add capabilities** — built-ins, discovered Restate handlers, and MCP servers | [Tool system](docs/tools.md) · [MCP configuration](docs/mcp-configuration.md) |
| **Work with files and commands** — local development directories or Modal sandboxes | [Sandboxes](docs/sandboxes.md) |

The detailed guides include execution diagrams and the boundaries behind each
feature.

## Read the code

Start with [PROJECT.md](PROJECT.md) for a file-by-file reading order, or the
[documentation index](docs/README.md) for the full guide. Before changing
runtime behavior, read the [agent guide](docs/agent-guide.md).

```sh
pnpm lint
pnpm build
pnpm test
pnpm bundle
```

The deterministic test suites need no Restate server or API key.
