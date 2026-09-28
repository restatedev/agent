# Source map

Start with [README.md](README.md) to run a local conversation and
[docs/architecture.md](docs/architecture.md) for state ownership.

## Packages

| Path | Purpose |
| --- | --- |
| `packages/libs/types/src/index.ts` | Zod wire schemas and inferred types |
| `packages/libs/types/src/services.ts` | Server service contracts |
| `packages/libs/types/src/targets.ts` | Lightweight ingress targets |
| `packages/libs/client/src/index.ts` | Typed client for one agent |
| `packages/libs/core/src` | Durable runtime |
| `packages/apps/web` | Optional local Next.js conversation UI and thin server adapter |

## Core reading order

Paths below are relative to `packages/libs/core/src`.

1. `app.ts` registers the runtime services.
2. `agent/service.ts` assembles the Agent object from one handler group per
   concern. `agent/turns.ts` routes input and reconciles a turn's completion;
   `agent/start-turn.ts` snapshots profile/configuration and starts a turn;
   `active-turn.ts` owns active-work bookkeeping and FIFO steering
   reconciliation. `agent/guards.ts` holds the shared authorization checks.
3. `session/service.ts` implements `doTurn`: open history once, build context,
   run bounded steps, handle pending work and control, then finalize.
4. `session/step.ts` performs one model/policy/tool transition;
   `session/turn-compaction.ts` shrinks the turn's working context when it
   outgrows the model's window.
5. `agent-config.ts` says what the agent is: models, context window, base
   instructions and the built-in tools, which live in `tools/` and are
   written with `tools-api.ts`. `session/tools.ts` is the tool registry and
   dispatcher;
   `session/tool-search.ts` and `session/program-tool.ts` are the runtime's
   own searchTools and executeProgram. `dynamic-tools.ts` and `mcp-tools.ts`
   implement external catalogs and calls over one `refresh-cache.ts`;
   `mcp-config.ts` resolves operator configuration and credential references.
6. `session/history.ts` owns append-only storage and compaction checkpoints.
   `agent/notifications.ts` supplies change watermarks to consumers.
7. `agent/profile.ts`, `agent/memories.ts`, `agent/approvals.ts`,
   `agent/schedules.ts` and `agent/sub-agents.ts` each own their state keys,
   handlers and notification topic. `agent/lifecycle.ts` creates and retires
   the agent.
8. `sandbox/turn.ts` acquires and suspends the sandbox inside the turn.
   `model/inference.ts` makes the journaled model calls and
   `model/provider.ts` owns provider behavior and builds the system prompt.
9. `ptc/runtime.ts` and `ptc/guest.ts` implement replay-safe programmatic tools.

`Agent` and `AgentSession` share the agent ID as their key. There is no account object or browser-session
service. Child metadata names its parent; the parent stores its child list.

## UI path

`app/page.tsx` selects `?agent=` (default `demo`). `src/use-agent.ts` loads one
snapshot and follows per-agent notifications. `src/app.tsx` wires the panels,
each in its own module: `composer.tsx`, `transcript.tsx`, `approvals-panel.tsx`,
`inspector.tsx` (profile and tools), `memories-schedules.tsx`, `status.tsx` and
`agent-navigation.tsx`. Agent switching is ordinary navigation; there is no
workspace cache or global account directory.

`app/api/agent/[agentId]/[operation]/route.ts` serves the `READS` and
`MUTATIONS` tables in `src/server/operations.ts`; the browser client in
`src/agent-client.ts` derives its types from them. `src/server/agent-snapshot.ts`
captures notification watermarks before reading data and fetches only changed
topics on subsequent polls.

## Validation and reference

- `packages/libs/core/test`: deterministic runtime, control, history,
  approvals, PTC, MCP, sandbox, memory, scheduling and delegation coverage.
- `packages/libs/client/test`: the ingress client's follow loop.
- `packages/apps/web/test`: snapshot loading, pagination, merging and the
  request guard.
- `docs/agent-guide.md`: invariants for maintainers and coding agents.
