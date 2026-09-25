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
| `packages/libs/core/src` | Durable runtime (`@restate-agents/runtime`) |
| `vendor/restate-agents-core-*.tgz` | The agent SDK `@restate-agents/core`, vendored until it is published |
| `packages/apps/web` | Optional local Next.js conversation UI and thin server adapter |

## Core reading order

Paths below are relative to `packages/libs/core/src`.

1. `app.ts` registers the runtime services.
2. `agent/service.ts` assembles the Agent object from one handler group per
   concern. `agent/turns.ts` routes input, snapshots profile/configuration,
   starts a turn, and reconciles its completion; `active-turn.ts` owns
   active-work bookkeeping and FIFO steering reconciliation. `agent/guards.ts`
   holds the shared authorization checks.
3. `session/service.ts` implements `doTurn`: open history once, build context
   and the turn's tool catalog, then make one run of the agent SDK
   (`@restate-agents/core`), which owns the model/tool loop, steering,
   interruption, background tools and finalization. `session/progress.ts`
   supplies the steering source and writes the run's progress to the transcript.
4. `session/guardrails.ts` gates each concrete tool call and the final text
   with SDK policy agents; `session/turn-context.ts` defines the per-turn
   context the tools receive.
5. `session/tools.ts` lists the built-in tools; definitions live in
   `session/tools/`, grouped by what they touch, and use the SDK's
   `tool`/`asyncTool`. `session/turn-tools.ts` assembles the permitted catalog
   for one turn from built-ins, Restate handlers (`restate-tools.ts`) and MCP
   servers. `mcp-config.ts` resolves operator configuration and credential
   references.
6. `session/history.ts` owns append-only storage and compaction checkpoints.
   `agent/notifications.ts` supplies change watermarks to consumers.
7. `agent/profile.ts` (memories included), `agent/approvals.ts`,
   `agent/schedules.ts` and `agent/sub-agents.ts` each own their state keys,
   handlers and notification topic. `agent/lifecycle.ts` creates and retires
   the agent.
8. `sandbox/turn.ts` acquires and suspends the sandbox inside the turn.
   `model/models.ts` defines the journaled agent, guardrail and compactor
   models; `model/compactor.ts` summarizes history with a one-step SDK agent.

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

- `packages/libs/core/test`: deterministic control, history, approvals, MCP,
  sandbox, memory, scheduling and delegation coverage, including delegation
  through PTC; `tool-harness.mjs` runs tools through a real SDK run.
- `packages/libs/client/test`: the ingress client's follow loop.
- `packages/apps/web/test`: snapshot loading, pagination, merging and the
  request guard.
- `docs/agent-guide.md`: invariants for maintainers and coding agents.
