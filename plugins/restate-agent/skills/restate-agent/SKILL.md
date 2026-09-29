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
  web UI. Also use for natural-language customization requests about tool-context
  size, programmatic tool calls, steering, approvals, memory, compaction,
  schedules, sandbox providers, and UI updates.
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

Durable operations and completed results are journaled. After a crash, the
turn replays deterministic code and reuses recorded results; an external effect
that finished before its result was recorded may run again. Tools, approvals
and sub-agents can wait for minutes or days without holding a process. Load
the `restate-gen-sdk` skill as well: every handler and tool here is generator
code, and its rules apply.

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
| Keep a large tool catalog out of model context, or compose calls in JavaScript | Use `searchTools` for deferred schemas; use `executeProgram` for compact intermediate results | `references/tools.md` |
| A tool that changes the agent's own durable state | Call an internal `Agent` handler; check the live turn and enforce the named grant where needed | `references/agent-controller.md`, `references/agent-handlers.md` |
| A new client or UI operation | Contract in `types/src/services.ts`, handler in `agent/`, client method, UI table entry | `references/agent-handlers.md` |
| A new kind of transcript entry | `ConversationEventSchema` + an explicit relevance decision | `references/agent-handlers.md` |
| Change `ask`, `steer`, `interrupt`, `deliver`, turn completion, or Agent lifecycle | Preserve routing, reconciliation, and one-way turn start | `references/agent-controller.md` |
| Change approval or child-agent behavior | Preserve the controller/session split and turn-owned work | `references/agent-controller.md`, `references/runtime-customization.md` |
| Change memories, compaction or what enters model context | Choose the appropriate state, history, or working-context owner | `references/runtime-customization.md` |
| Add UI updates or schedules | Extend the existing notification or timer boundary | `references/agent-controller.md`, `references/runtime-customization.md` |
| Integrate a sandbox provider or add a workspace operation | Keep turn-owned lifecycle and implement the provider/client boundary | `references/sandboxes.md` |
| Change models, providers, prompts or the context window | `agent-config.ts` (`provider:model` IDs); `PROVIDERS` in `model/provider.ts` | this file |
| Users, logins, per-user credentials, many agents per account | Add an app layer on top of the agent | `references/app-layer.md` |
| Test and validate a change | Record/replay tests, then the validation commands | `references/testing.md` |

## Turn a request into a change

When someone describes a product behavior rather than a file or API, first
locate its owner with the table above and read the linked reference and current
source. Say which behavior already exists, which part is a customization, and
which part needs a new app layer. The current reference has operator-configured
MCP servers with optional environment tokens, per-agent memories and schedules,
and an optional local UI. It has a per-call model output limit, but no
turn- or user-level token-usage budget, user OAuth flow, account service, or
eval service. Do not present an extension pattern as existing code.

Make the requested behavior concrete through its typed contract, owner module,
turn snapshot (if needed), client/UI path, and replay or protocol test. Prefer
changing the existing owner; add an object or service only when it has an
independent key, lifecycle, or deployment need.

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
  controller's live turn (`requireTurnTool` or `activeTurn.accepting`, depending
  on where the named grant is enforced).
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
- [ ] External I/O uses `restate.run` / `toolRun` with an explicit bounded
      retry policy, or a durable Restate RPC. External writes use a stable
      idempotency key where the provider supports one; replay alone does not
      make them exactly-once.
- [ ] A pending tool's `complete` derives everything from its input and
      `toolCallId`.
- [ ] New handlers state shared vs exclusive and `ingressPrivate` for
      internal callbacks, in `agent/service.ts`.
- [ ] No exclusive call cycle between objects (Agent → X → the same Agent).
- [ ] Wire schemas in `packages/libs/types` match every caller, and the client
      and UI tables are updated for external handlers.
- [ ] Tests cover changed behavior; replay tests cover durable effects or
      turn-control changes.
- [ ] `pnpm lint && pnpm build && pnpm test && pnpm bundle` and
      `git diff --check` pass, and the docs are updated.
