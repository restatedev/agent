---
name: restate-agent
description: >
  Extend the Restate reference agent (restatedev/agent): a durable AI agent
  whose controller (Agent) and turn runtime (AgentSession.doTurn) are Restate
  virtual objects written with the generator SDK. Use when working in this
  repository or a fork of it: adding or changing built-in tools
  (defineAgentTool, agent-config.ts), exposing a Restate handler or an MCP
  server as a tool, adding Agent handlers, transcript events or UI
  operations, changing models or instructions, or growing the reference into
  a full application with users, sessions, credentials and a backend for the
  web UI. Also use for requests phrased as behavior: tool-context size,
  programmatic tool calls, steering, approvals, memory, compaction,
  schedules, sandbox providers and live UI updates.
---

# Extending the Restate reference agent

This repository is a complete agent, not a library. Two virtual objects,
both keyed by `agentId`, run it:

- **`Agent`** (`agent/`) is the controller. Its exclusive handlers decide
  everything about the conversation: start a turn, queue or steer a
  message, interrupt, profile, memories, approvals, schedules, sub-agents,
  notifications. It never runs a turn.
- **`AgentSession`** (`session/`) owns the transcript and runs one turn at a
  time in `doTurn`: model call, guardrails, tool batch, repeat. The turn's
  Restate invocation ID is its `turnId`.

Every durable step of a turn is journaled. After a crash, the turn replays
and reuses the recorded results. An external call that finished before its
result was recorded can run again, so external writes need idempotency.
Tools, approvals and sub-agents can wait for minutes or days without holding
a process.

Load the `restate-gen-sdk` skill as well: every handler and tool here is
generator code, and its rules apply.

## Detect context

1. `packages/libs/core/src/agent-config.ts` exists → this skill applies.
2. Paths in this skill:
   - source paths such as `agent/service.ts` are relative to
     `packages/libs/core/src/`;
   - test paths such as `test/local-agent.test.mjs` are relative to
     `packages/libs/core/`;
   - paths that start with `packages/` or `docs/` are relative to the
     repository root.
3. Read `docs/agent-guide.md` before changing runtime behavior. It lists the
   invariants and the owner module of each concern. The docs index is
   `docs/README.md`.
4. Check `git status` first. Never stage or print credential files
   (`modal.sh`, `ngrok.yml`, `.env*`).

## What the agent is: `agent-config.ts`

One file defines the agent:

- the models (agent, guardrail, compactor);
- the context window and the compaction threshold;
- `baseInstructions`;
- the built-in `tools` list;
- the `programTool` switch.

Change the agent there. The turn runtime in `session/` knows no tool by
name except its own (`searchTools`, `executeProgram`) and `humanApproval`.
The controller in `agent/` checks the grants of the tools that call it by
name (`createSchedule`, `createSubAgent`, ...), so renaming one of those
means editing `agent/` too.

### Models

Model IDs are `provider:model`, for example `"anthropic:claude-sonnet-5"`.
The providers are `openai`, `anthropic`, `google`, `xai`, `deepseek` and
`openai-compatible` (for open models on Ollama, vLLM or OpenRouter).

- Each provider needs its API key in the environment. The table is in
  `docs/configuration.md#models`.
- When the agent model changes, set `context.windowTokens` to its context
  window.
- A running turn keeps its model. A change applies to new turns.
- To add a provider, add an entry to `PROVIDERS` in `model/provider.ts`.
  Keep the AI SDK inside `model/`: the rest of the code imports message
  types from `model/index.ts`.

## Find the right place for a goal

| Goal | Reference |
| --- | --- |
| Call an API or run code as a tool (a foreground tool) | `references/tools.md` |
| Wait on a timer, a person or a long job without blocking the turn (a pending tool) | `references/tools.md` |
| Expose a separately deployed Restate handler, or a remote MCP server | `references/tools.md` |
| Keep a large tool catalog out of model context, or compose calls in JavaScript | `references/tools.md` |
| A tool that changes the agent's own durable state | `references/tools.md`, then `references/agent-handlers.md` |
| A new client or UI operation, or a new transcript event | `references/agent-handlers.md` |
| Change `ask`, `steer`, `interrupt`, `deliver`, turn end, lifecycle, sub-agents or notifications | `references/agent-controller.md` |
| Change approvals, memories, compaction, schedules or what the model sees | `references/runtime-customization.md` |
| Run the sandbox on another platform, or add a workspace operation | `references/sandboxes.md` |
| Change models, providers, prompts or the context window | `agent-config.ts`; see "Models" above |
| Users, logins, per-user credentials, many agents per account | `references/app-layer.md` |
| Let a UI run tools itself (AG-UI frontend tools, CopilotKit) | `references/client-tools.md` |
| Test and validate a change | `references/testing.md` |

## Turn a request into a change

When someone describes a product behavior rather than a file or API:

1. Find its owner with the table above, then read the reference and the
   current source.
2. Say which part already exists, which part is a customization, and which
   part needs a new app layer.
3. Make it concrete: the typed contract, the owner module, the turn
   snapshot if the turn needs it, the client and UI path, and the tests.

Prefer changing the existing owner. Add an object or service only when it
has its own key, lifecycle or deployment.

Do not present an extension pattern as existing code. Today the reference
has:

- operator-configured MCP servers, with optional tokens from the
  environment;
- per-agent memories and schedules;
- a per-call model output limit;
- an optional local UI.

It has no account service, no user OAuth flow, no turn- or user-level token
budget, and no eval service.

## Working rules

- **Built-in tools run inside `doTurn`.** Make one durable with
  `restate.run` (`toolRun`), not by turning it into a service. Split out a
  service only when it should deploy, scale or be owned separately; then
  expose it as a discovered tool.
- **The turn owns its work.** Every foreground call in one model response
  starts together and is joined. Pending work belongs to the turn and is
  cancelled with it. Never leave a spawned task unjoined.
- **Cancellation is not failure.** Return `failed(...)` for what the model
  can fix; rethrow cancellation (the helpers in `tools-api.ts` do).
- **Trusted values come from the context.** A tool reads `agentId`,
  `turnId` and grants from its `ToolCallContext`, never from model input.
  Handlers that act for a turn take its `turnId` and check it against the
  controller's live turn.
- **No exclusive call cycles.** An exclusive handler never waits on a call
  that comes back to an exclusive handler of the same key. This is why
  `Agent` starts `doTurn` with a one-way send.
- **The transcript is append-only and public.** Tool arguments, results and
  reasoning never enter it; a tool may add summary `transcript` entries.
- **Turns replay from their journal.** Code between journaled steps must
  decide the same way every time. A change to the order or kind of a turn's
  steps affects new turns only: running turns finish on the version they
  started on, so ship the change as a new deployment version.
- **Keep one owner per concern.** `docs/agent-guide.md#where-a-change-belongs`
  maps each concern to its module. Prefer adding to the owner over a new
  abstraction, and update the docs that describe the behavior you change.

## Rules to check before finishing

- [ ] The tool is in `agent-config.ts` `tools`, with a precise `description`
      and, if it needs usage guidance, `instructions`, not `baseInstructions`.
- [ ] External I/O runs in `restate.run` / `toolRun` with a bounded retry
      policy, or is a durable Restate call. External writes carry a stable
      idempotency key where the provider supports one; replay alone does
      not make them exactly-once.
- [ ] A pending tool's `complete` derives everything from its input and
      `toolCallId`.
- [ ] New handlers state shared vs exclusive, retention, and
      `ingressPrivate` for internal callbacks, in `agent/service.ts`.
- [ ] No exclusive call cycle between objects (Agent → X → the same Agent).
- [ ] Wire schemas in `packages/libs/types` match every caller, and the client
      and UI tables are updated for external handlers.
- [ ] Tests cover the changed behavior, with a replay test for durable
      effects and turn-control changes.
- [ ] `pnpm lint && pnpm build && pnpm test && pnpm bundle` and
      `git diff --check` pass, and the docs are updated.
