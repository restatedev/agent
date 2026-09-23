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
2. `agent/service.ts` routes input, snapshots profile/configuration, starts a
   turn, and reconciles its completion. `active-turn.ts` owns active-work
   bookkeeping and FIFO steering reconciliation.
3. `session/service.ts` implements `doTurn`: open history once, build context,
   run bounded steps, handle pending work and control, then finalize.
4. `session/step.ts` performs one model/policy/tool transition.
5. `session/tools.ts` defines built-ins. `dynamic-tools.ts` and `mcp-tools.ts`
   implement external catalogs and calls. `mcp-config.ts` resolves operator
   configuration and credential references.
6. `session/history.ts` owns append-only storage and compaction checkpoints.
   `notifications/service.ts` supplies change watermarks to consumers.
7. `agent/profile.ts`, `agent/memory.ts`, and `agent/approval.ts` own responsive
   agent-local state. `agent/sub-agent.ts` attenuates child configuration;
   delegation coordination stays in `agent/service.ts`.
8. `scheduler/service.ts` owns per-agent timers. `sandbox/service.ts` owns
   resource lifecycle. `gateway/service.ts` and `gateway/model.ts` own model
   admission and provider behavior.
9. `ptc/runtime.ts` and `ptc/guest.ts` implement replay-safe programmatic tools.

`Agent`, `AgentSession`, `AgentNotifications`, `AgentScheduler`, and `Sandbox`
share the agent ID as their key. There is no account object or browser-session
service. Child metadata names its parent; the parent stores its child list.

## UI path

`app/page.tsx` selects `?agent=` (default `demo`). `src/use-agent.ts` loads one
snapshot and follows per-agent notifications. `src/app.tsx` renders conversation,
control, approvals, context, memories and schedules. Agent switching is ordinary
navigation; there is no workspace cache or global account directory.

`app/api/agent/[agentId]/[operation]/route.ts` maps browser requests to the typed
client. `src/server/agent-snapshot.ts` captures notification watermarks before
reading data and fetches only changed topics on subsequent polls.

## Validation and reference

- `packages/libs/core/test/ptc`: deterministic runtime, control, PTC, MCP,
  memory, scheduling and delegation coverage.
- `packages/apps/web/test`: snapshot loading, pagination and merging.
- `docs/agent-guide.md`: invariants for maintainers and coding agents.
