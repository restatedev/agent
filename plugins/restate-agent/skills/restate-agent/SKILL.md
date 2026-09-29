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
  web UI.
---

# Extending the Restate reference agent

This repository is a complete agent, not a library. Two virtual objects,
both keyed by `agentId`, run it:

- **`Agent`** (`packages/libs/core/src/agent/`) is the controller. Its
  exclusive handlers decide everything about the conversation: start a turn,
  queue or steer a message, interrupt, profile, memories, approvals,
  schedules, sub-agents, notifications. It never runs a turn.
- **`AgentSession`** (`packages/libs/core/src/session/`) owns the transcript
  and runs one turn at a time in `doTurn`: model call, guardrails, tool
  batch, repeat. The turn's Restate invocation ID is its `turnId`.

Everything in a turn is journaled, so a crash resumes the turn where it
stopped, and tools, approvals and sub-agents can wait for minutes or days
without holding a process. Load the `restate-gen-sdk` skill as well: every
handler and tool here is generator code, and its rules apply.

## Detect context

1. `packages/libs/core/src/agent-config.ts` exists → this skill applies.
   Paths below are relative to `packages/libs/core` unless they start at the
   repository root.
2. Read `docs/agent-guide.md` before changing runtime behavior. It lists the
   invariants and the owner module of each concern. The docs index is
   `docs/README.md`.
3. Check `git status` first. Never stage or print credential files
   (`modal.sh`, `ngrok.yml`, `.env*`).

## What the agent is: `agent-config.ts`

One file defines the agent: models (agent, guardrail, compactor), context
window and compaction threshold, `baseInstructions`, the built-in `tools`
list, and the `programTool` switch. Change the agent there. The runtime
knows no tool by name except its own (`searchTools`, `executeProgram`) and
`humanApproval`.

## Find the right place for a goal

| Goal | Do this | Reference |
| --- | --- | --- |
| Call an API or run code as a tool | A foreground tool: `defineAgentTool` + `toolRun`, added to `tools` | `references/tools.md` |
| Wait on a timer, a person or a long job without blocking the turn | A pending tool: `run` returns `pending`, `complete` waits | `references/tools.md` |
| Expose an existing or separately deployed Restate handler | Annotate it with `restate.dev/agent: <name>`; no code here | `references/tools.md` |
| Use a remote MCP server | Add it to `MCP_SERVERS_JSON` on the core service | `references/tools.md` |
| A tool that changes the agent's own durable state | The tool calls an internal `Agent` handler, which checks the live turn's grant | `references/agent-handlers.md` |
| A new client or UI operation | Contract in `types/src/services.ts`, handler in `agent/`, client method, UI table entry | `references/agent-handlers.md` |
| A new kind of transcript entry | `ConversationEventSchema` + an explicit relevance decision | `references/agent-handlers.md` |
| Change models, providers, prompts or the context window | `agent-config.ts` (`provider:model` IDs); `PROVIDERS` in `model/provider.ts` | this file |
| Users, logins, per-user credentials, many agents per account | Add an app layer on top of the agent | `references/app-layer.md` |
| Test and validate a change | Record/replay tests, then the validation commands | `references/testing.md` |

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
  controller's live turn (`requireTurnTool`).
- **The transcript is append-only and public.** Tool arguments, results and
  reasoning never enter it; a tool may add summary `transcript` entries.
- **Turns replay from their journal.** Code between journaled steps must
  decide the same way every time. A change to the order or kind of a turn's
  steps affects new turns; running turns finish on the version they started
  on, so ship it as a new deployment version.
- **Keep one owner per concern.** `docs/agent-guide.md#where-a-change-belongs`
  maps each concern to its module. Prefer adding to the owner over a new
  abstraction, and update the docs that describe the behavior you change.

## Rules to check before finishing

- [ ] The tool is in `agent-config.ts` `tools`, with a precise `description`
      and, if it needs usage guidance, `instructions`, not `baseInstructions`.
- [ ] Every side effect is inside `restate.run` / `toolRun`, with a retry
      policy, and external writes carry an idempotency key (the `toolCallId`
      is stable across retries).
- [ ] A pending tool's `complete` derives everything from its input and
      `toolCallId`.
- [ ] New handlers state shared vs exclusive and `ingressPrivate` for
      internal callbacks, in `agent/service.ts`.
- [ ] No exclusive call cycle between objects (Agent → X → the same Agent).
- [ ] Wire schemas in `packages/libs/types` match every caller, and the client
      and UI tables are updated for external handlers.
- [ ] Tests cover the change, including a replay of the recorded journal.
- [ ] `pnpm lint && pnpm build && pnpm test && pnpm bundle` and
      `git diff --check` pass, and the docs are updated.
