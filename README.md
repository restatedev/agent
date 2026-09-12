# Restate durable agent reference

An end-to-end reference implementation of a **durable, single-agent harness and
runtime** on Restate. It combines a model-directed tool-use loop with durable
conversation state, context engineering, policy enforcement, human
intervention, resource lifecycle, observability, and evaluation.

The model and harness together form the operational agent: the model selects
tools, acts on observations, revises its approach, and decides when work is
complete, while Restate makes the surrounding execution recoverable,
steerable, interruptible, concurrent, and bounded.

The weather domain is intentionally simple so the production-oriented agent
semantics remain easy to inspect from ingress to model call and back.

## Documentation

Start with [`docs/README.md`](docs/README.md) for the maintainer guide. It links
the architecture and state flow, Agent protocol, turn runtime, tool contracts,
sandbox providers, development workflow, and evaluation harness.

For Codex, Claude Code, or another coding agent, point it first to
[`docs/agent-guide.md`](docs/agent-guide.md). That guide records the
source-of-truth order, ownership boundaries, invariants, and change-routing
map.

## System vocabulary

| Term | Meaning in this repository |
| --- | --- |
| Agent | The model and harness operating together for one `agentId` |
| `User` Virtual Object | Verified identity, agent directory, shared MCP connections and encrypted credentials |
| `UserSession` Virtual Object | Expiring, revocable browser sessions |
| `Agent` Virtual Object | The deterministic controller for active work, queued input, profile, approvals, MCP authorization, and externally delivered messages |
| `AgentSession` Virtual Object | The transcript owner and durable turn executor for the same `agentId` |
| `AgentNotifications` Virtual Object | The per-Agent invalidation stream for history, profile, approvals, MCP authorization actions, and schedules |
| `AgentScheduler` Virtual Object | The per-Agent owner of durable schedules, delayed invocations, and recurrence |
| Agent run | One `AgentSession.doTurn` invocation; its invocation ID is the `turnId` |
| Agent loop | The repeated model-action-observation cycle inside that run |
| Loop iteration | One `agentStep`: model proposal, policy evaluation, and optional tool batch |
| Agent harness/runtime | The context, tools, control, durability, policies, and resources that enable the model to act |
| Evaluation harness | The `Evals` service that runs and grades black-box tasks |

The public history is a **conversation event log**, not the complete agent
trajectory. Raw tool I/O, private model reasoning, retries, and child
invocation details remain in working context and Restate observability.

This vocabulary follows current distinctions between
[workflows and agents](https://www.anthropic.com/engineering/building-effective-agents),
an [agent harness and an evaluation harness](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
and prompt construction versus
[context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
The loop is related to the
[ReAct](https://arxiv.org/abs/2210.03629) pattern without persisting private
chain-of-thought.

## Capabilities

| Capability | What this implementation does |
| --- | --- |
| Durable agent runs | Each `AgentSession.doTurn` invocation journals model calls, signals, timers, tool observations, and control decisions for recovery and replay. |
| Responsive controller | `Agent/{agentId}` serializes routing and current-state mutations without blocking on the long-running turn. |
| Session-owned conversation | `AgentSession/{agentId}` stores the append-only transcript and summary checkpoint beside the exclusive turn handler. |
| Queue, steer, and interrupt | Busy `ask` queues; steering preserves current tool work and enters the next iteration; interruption stops unfinished work and makes one tool-free finalization call. |
| Parallel tool batches | Independent calls from one model response are spawned together and joined as a batch. |
| Programmatic tool calling (PTC) | The model can write JavaScript to coordinate built-in, dynamic Restate, and MCP tools, returning only a compact result to model context. Enabled by default, with replay-safe promise completion and normal subtool policy enforcement. |
| Web search | Tavily keyless search returns bounded source snippets and URLs. Enabled by default, with a durable per-Agent UI toggle; available directly and through PTC. |
| Cross-step pending operations | `sleep` and `humanApproval` can acknowledge pending work and complete in later iterations. |
| Selective cancellation | The model can cancel one pending operation by stable ID without stopping unrelated work. |
| Runtime guardrails | A separate policy pass gates the exact proposed text or complete tool batch before it runs. Non-allow decisions receive an independent confirmation pass. |
| Human-in-the-loop approval | Policy gates and the explicit approval tool register durable Agent state and resume through turn-scoped signals. |
| User identity and ownership | Google Workspace sign-in restricted to `restate.dev` through the BFF, private per-user agents, account-level connections, and per-agent tool grants. See [setup](docs/user-identity.md). |
| Persistent context | Instructions, guardrails, tool grants, and web search availability are durable per Agent. Semantic memories are shared per User; Agent includes the entire collection in each turn. |
| General change notifications | `AgentNotifications/{agentId}` maintains revisioned `history`, `profile`, `approvals`, `mcpAuth`, and `schedules` watermarks that wake clients to re-read authoritative state. |
| Non-destructive compaction | Older conversation prefixes are summarized for model context without rewriting or deleting transcript entries. |
| Semantic activity | Progress, concise model-authored activity, and structured tool lifecycle make multi-step runs readable without exposing chain-of-thought or raw tool data. |
| Durable schedules | `AgentScheduler/{agentId}` owns durable one-shot and fixed-interval messages and delivers them through the Agent's generic `queue`, `steer`, or `interrupt` router. |
| Inference admission control | Model calls use a Restate scope with provider-, model-, and agent-level concurrency keys, bounded retries, and cancellation propagation. |
| Agent-scoped sandbox | A `Sandbox` Virtual Object lazily provisions/resumes a local or Modal workspace, lends it to one turn, and suspends it after idle release. |
| Restate-native dynamic tools | A deployed JSON handler can opt in through `restate.dev/agent` metadata; one journaled catalog snapshot drives both inference and execution. |
| MCP tools | User-configured stateless 2026-07-28 or stateful 2025-era Streamable HTTP endpoints contribute tools to the same per-turn catalog snapshot, with durable OAuth waits when required. |
| Encrypted credentials | MCP OAuth state, PATs/API keys, and PKCE flow state are encrypted before Restate ingress using AES-256-GCM-SIV and `APP_SECRET_KEY`; state and journal payloads carry ciphertext. |
| Durable evaluation harness | Concurrent isolated trials drive the public protocol and return code-based assertions plus the observed transcript. |

## Architecture

Read the system in three views: **control the task**, **execute the task**, then
**refresh the client**. Each view hides the internals of the other layers.

### 1. Agent: control the task

From Agent's perspective, `AgentSession.doTurn` is an opaque, long-running task.
Agent starts it, tracks its invocation ID, sends control signals, and reconciles
its terminal outcome. Models, tools, sandboxes, and notifications are omitted
from this view.

```mermaid
flowchart TD
  Input["User commands / external messages"] --> A["Agent<br/>Responsive controller"]
  A -->|"start with snapshot"| Task["AgentSession.doTurn<br/>Opaque durable task"]
  A -.->|"steer / interrupt / resolve waits"| Task
  Task -->|"onTurnEnd"| A
```

Agent owns only the state that must remain responsive while a run is active:

- active `doTurn` invocation ID and accepted interrupt reason;
- pending user/event entries and steering reconciliation batches;
- instructions, guardrails, per-agent tool grants, and web search availability;
- immutable user ownership and per-turn authorization actions (credentials belong to User);
- pending approvals; and
- routing of external deliveries according to their busy-turn policy.

An idle `ask` snapshots the profile plus a minimal MCP credential for each
server (`serverId` and `encryptedToken`) and one-way sends
`AgentSession.doTurn`. A busy `ask` stores a queued user entry in Agent state.
`steer` drains that queue into one durable signal;
`interrupt` signals the active invocation and optionally stores a replacement
request for the next turn. `onTurnEnd` retires exactly the matching invocation,
recovers missed steering, clears abandoned approvals and MCP authorization
actions, and dispatches queued work.

At most one task is active per Agent. Tracking is event-driven, not a polling
loop: the task calls `onTurnEnd`. Scheduled input is simply another external
delivery through `Agent.deliver`; its timing belongs to `AgentScheduler`.

### 2. AgentSession.doTurn: execute the task

Now open the task box. One invocation owns the model/tool loop and its working
context. The diagram shows normal progress; the turn supervisor can interrupt
the current step or wait without waiting for the next loop iteration.

```mermaid
flowchart TD
  Open["Load conversation<br/>Discover tool catalog"] --> Step["Run one agentStep<br/>Model, policy, tools"]
  Step --> Apply["Record outcomes<br/>Consume steering"]
  Apply --> Next{"Next action?"}
  Next -->|"continue"| Step
  Next -->|"pending work"| Wait["Wait for result or steering"]
  Wait --> Step
  Next -->|"done"| Finish["Release resources<br/>Report outcome and close history"]
```

`agentStep` uses `ModelGateway` for inference and policy checks. Its tools can
be built-ins, discovered Restate handlers, or MCP calls. PTC coordinates those
same tools within a step; sandbox and scheduling services remain behind their
tool interfaces. These details do not change Agent's task contract.

AgentSession is keyed by the same `agentId`. It owns transcript chunks,
sequence allocation, compaction reservation, and the current summary.
`history` and `compact` are shared handlers; `applyCompaction` and `doTurn` are
exclusive.

At the start of `doTurn`, `history.openTurn()` loads the summary, uncompacted
entries, sequence cursor, and tail chunk once. The handler appends its activated
input, builds model context, and then writes new entries through an
invocation-local transcript writer. It does not repeatedly read/modify/write
the whole conversation.

The running invocation owns working messages, the step bound, guardrail
decisions, the steering inbox, pending operations, discovered tool snapshot,
sandbox lease context, and tool state. Each iteration spawns one bounded
`agentStep`, applies its returned delta, and decides whether to iterate, wait,
finalize, or finish.

Graceful interruption stops and joins unfinished work, makes one tool-free
finalization call over retained results, and then reports the outcome. External
invocation cancellation follows its separate cleanup path without model
finalization. See [turn runtime](docs/turn-runtime.md) for those exit paths.

### 3. Notifications: refresh the client

Notifications do not drive the task. They tell clients which authoritative data
to re-read. After loading initial state and revision watermarks, a client repeats
this cycle:

```mermaid
sequenceDiagram
  participant C as Client / BFF
  participant N as AgentNotifications
  participant O as State owner
  C->>N: watch(afterRevision)
  O->>O: Change state
  O-)N: publish(topic)
  N-->>C: Updated revision + topic versions
  C->>O: Re-read changed data
  O-->>C: Current data
```

“State owner” stands for AgentSession (history), Agent (profile, approvals, MCP
authorization actions), or AgentScheduler (schedules), not another service.
AgentNotifications is keyed by the same `agentId` and stores only revision
watermarks and waiting subscriptions. It does not store or return domain data.
The registration re-check catches changes that arrive before the watch starts.

See [architecture and data flow](docs/architecture.md) for ownership details and
the individual control sequences.

## Control semantics

| Action | When idle | While a turn is active |
| --- | --- | --- |
| `ask(message)` | Starts `doTurn` and returns its invocation ID. | Stores the message for the next turn and returns the active ID plus queue size. |
| `steer(message)` | Returns `false`. | Moves pending entries plus the new instruction into the active turn after the current step settles. Running tools are not cancelled. |
| `interrupt(reason, message?)` | Returns `false`. | Stops and joins unfinished work, finalizes completed work, and optionally queues a replacement request. |
| `cancelOperation(id)` | Not a controller action. | A model tool stops one pending operation while the rest of the run continues. |
| Scheduled message | Starts a turn. | Uses its `queue`, `steer`, or `interrupt` policy; an already-interrupting turn always falls back to queue. |
| External cancellation | Nothing to cancel. | Records cancellation, releases owned resources, reconciles Agent, and rethrows to Restate without model finalization. |

Queueing changes *when* input runs. Steering changes the active request without
discarding work. Interruption ends the active request gracefully. Selective
cancellation targets one pending operation.

## Conversation history and notifications

The canonical log is append-only and stored in fixed-size AgentSession state
chunks with stable positive sequence numbers. User messages retain their
delivery metadata; later `dispatch` and `steer` events explain activation.

A busy `ask` is held in Agent state until activation. On normal completion,
Agent can enqueue a successor `doTurn`, but the same-key exclusive handler
cannot begin until the current `doTurn` appends its terminal entries and
returns. This preserves the old turn's terminal boundary before the queued
entries and successor dispatch.

Clients read the log through `AgentSession.history` using an inclusive cursor.
For changes, AgentNotifications exposes:

```ts
type AgentNotificationSnapshot = {
  revision: number;
  versions: {
    history: number;
    profile: number;
    approvals: number;
    mcpAuth: number;
    schedules: number;
  };
};
```

The client-facing `watchNotifications` method targets
`AgentNotifications.watch` and parks on a caller-owned awakeable until any
version changes or its bounded wait expires. The notification contains no
domain data.
Clients drain history and re-read profile, approvals, MCP authorization
actions, or schedules when their watermark advances. The internal registration
re-check closes the read/watch race, and timeout/cancellation withdraws
abandoned subscriptions.

History contains user/assistant messages, control boundaries, resolved
approvals, progress, concise activity, tool lifecycle, memory metadata,
approval lifecycle, and scheduled delivery. Raw provider reasoning, tool
arguments, and tool results stay out of the public log.

## Compaction and context engineering

After a terminal outcome, AgentSession counts non-event messages since the
current checkpoint. At 32 it reserves the visible prefix and one-way starts
shared `AgentSession.compact`. The handler reads that exact range, calls a cheap
model, and sends the result to exclusive `applyCompaction`. Only a matching
reservation is installed; transcript chunks remain intact.

A later turn receives the summary plus exact model-relevant entries after its
checkpoint. Derived status events are filtered by the exhaustive
`isDerivedConversationEvent` classifier.

## Tools

Built-in tools are self-contained definitions in `session/tools.ts`. Each keeps
its name, description, Zod schema, input validation, durable execution, pending
completion, transcript summary, and model result projection together.

Current built-ins:

| Tool | Kind | Purpose |
| --- | --- | --- |
| `getWeather` | foreground | Synthetic lookup for parallel-call examples |
| `webSearch` | foreground | Public web search via Tavily keyless access, with journaled source snippets and URLs |
| `sleep` | pending | Durable timer |
| `humanApproval` | pending | Explicit signal-backed human decision |
| `cancelOperation` | foreground control | Stop one pending task by operation ID |
| `manageMemory` | foreground Agent → User RPC | Set or delete shared user memories for personalization across agents |
| `scheduleMessage` / `cancelSchedule` / `listSchedules` | foreground AgentScheduler RPC | Manage durable scheduled input independently of the current turn |
| `listFiles` / `readFile` / `writeFile` / `executeCommand` | foreground sandbox | Work in the Agent-scoped workspace |
| `executeProgram` | foreground orchestration | Coordinate available tools in JavaScript, filter intermediate results, and return a compact JSON value |

All allowed foreground calls in one model response are spawned together and
joined. Pending tools acknowledge immediately and start completion tasks that
survive across later iterations. `toolCallId` is their stable operation ID.

### Web search

Web search is **enabled by default** through [Tavily keyless access](https://docs.tavily.com/documentation/keyless),
with no API key or OAuth setup. Toggle it in **Context → Web search**; the
per-Agent setting is saved immediately and applies from the next turn.
Searches use normal guardrails and can be called directly or through PTC.
Queries are sent to Tavily, and free access is rate-limited. See
[web search](docs/tools.md#web-search) for the input/output contract and limits.

### Programmatic tool calling (PTC)

PTC lets the model choose `executeProgram({source})` for work that benefits from
code: parallel lookups, dependent calls, filtering, joins, and aggregation. The
source is an `async tools => { ... }` function with access to every other
available built-in, Restate-discovered, and MCP tool. Intermediate results stay
inside the program; only its returned JSON or program failure goes back to the
model. Tool schemas remain in model context, and direct calls remain available.

Programs run in a bounded QuickJS/WebAssembly runtime inline in
`AgentSession.doTurn`. Native `Promise.all`, `Promise.any`, `Promise.race`, and
`Promise.allSettled` use host-controlled, journaled completion ordering for
replay. The wrapper needs no policy approval; each concrete subtool call still
uses its normal guardrails, human approvals, MCP authorization, and cancellation
behavior. Programs have no direct network or filesystem access.

PTC is **enabled by default**. Set `AGENT_PTC_ENABLED=false` on the core service
to hide it from new model calls; already-recorded program calls still replay.
For local development: `AGENT_PTC_ENABLED=false pnpm dev:service`.

Try asking in chat:

> Use executeProgram to look up the demo weather for Berlin, Paris, and London
> in parallel. Return only the warmest city and its temperature, and report any
> failed lookups. Do the comparison in JavaScript, not in another model round.

See the [PTC guide](docs/tools.md#programmatic-tool-calling-ptc) for source
examples, result contracts, execution limits, and interruption semantics.

### Dynamic Restate tools

A deployed JSON handler opts in with metadata:

```text
restate.dev/agent: query_grafana
```

`session/dynamic-tools.ts` reads an endpoint-local, coalescing Admin API cache.
A successful catalog refresh is reused for five minutes; failure with a prior
snapshot uses last-known-good data and retries after 30 seconds. The selected
catalog is returned through `restate.run`, so the turn journals one stable
snapshot for inference and execution.

The handler's documentation becomes the model description, and its JSON input
schema is nested under `input`. Virtual Objects and Workflows also require a
model-supplied `key`. Selected handlers run as foreground generic
`restate.call` children. Built-in names win collisions. Treat the annotation as
a trusted cluster capability boundary.

Configure discovery with:

```text
RESTATE_ADMIN_URL=http://localhost:9070
RESTATE_ADMIN_TOKEN=<optional bearer token>
```

### MCP tools

The core service and BFF must share `APP_SECRET_KEY`. Outside production it
defaults to `restate` for development; production requires a strong random
secret. Keep it stable across restarts. The encrypted credential format requires
fresh development state and MCP reauthorization; it does not rewrite old
plaintext journals. See [credential encryption](docs/credential-encryption.md).

User-configured MCP servers contribute tools through Streamable HTTP. Each
connection entry explicitly selects either stateless MCP revision `2026-07-28` or
the stateful 2025-era `initialize` protocol; the runtime does not guess or
silently fall back between them.

```json
{
  "id": "notion",
  "type": "http",
  "url": "https://mcp.notion.com/mcp",
  "protocol": "stateless",
  "auth": {"type": "oauth"}
}
```

Stateless servers are probed with `server/discover`; stateful servers use the
legacy `initialize` handshake. Both are then read through `tools/list`. The
runtime respects stateless cache TTLs up to five minutes, journals the selected
catalog and protocol verdict once per turn, and invokes the exact snapshotted definition.
Model-facing names are qualified as `mcp__<server-id>__<tool-name>` and safely
shortened when necessary.

OAuth state and bearer tokens live encrypted in the User VO. Each Agent profile
selects allowed tools from that user's connections. A new turn receives resolved
server definitions and only `{serverId, encryptedToken}`. The BFF handles OAuth
and PAT entry; User stores credentials, then Agent signals its waiting turn.
Multiple agents can share a connection flow without sharing their conversations.
See [identity, ownership, and setup](docs/user-identity.md).

MCP calls send a stable `Idempotency-Key` derived from the turn and tool-call
IDs, but MCP does not standardize deduplication, so mutating tools remain
potentially at-least-once. The implementation supports foreground tools and
text/structured results. It intentionally does not advertise MRTR client
capabilities or expose prompts, resources, Tasks, stdio, or the deprecated
standalone HTTP+SSE transport.

See [`docs/tools.md`](docs/tools.md) for the definition and discovery contracts.

## Guardrails and human approval

Guardrails are user-managed `{id, rule}` policies in the Agent profile. The
main agent model does not receive the list. After it proposes text or a complete
tool batch, the policy model returns `allow`, `deny`, or `require_approval`.
Every non-allow candidate is checked by a second independent policy review;
unconfirmed candidates become `allow`.

For PTC, the `executeProgram` wrapper is excluded from the batch policy check.
Each concrete call emitted by its program is gated separately before execution.

`deny` prevents publication/execution and returns policy feedback to the next
model iteration. Repeating the same block produces a deterministic refusal.
`require_approval` registers Agent state and waits on a signal before the exact
proposal can proceed. Later proposals are evaluated again; approval is reusable
only when materially within the recorded scope. Steering resets request-scoped
decisions.

The explicit `humanApproval` tool is separate: the agent model chooses it when
the task itself needs a human decision. Both forms expose pending state through
`Agent.approvals`, accept decisions through `resolveApproval`, and append the
delivered decision to AgentSession history.

Natural-language policies are probabilistic classification and do not replace
authentication, authorization, capability scoping, deterministic validation,
or sandbox isolation. Once the model returns a policy decision, the runtime
enforces it deterministically.

## Sandbox lifecycle

`Sandbox/{agentId}` owns one persistent workspace across turns. The first
sandbox tool lazily borrows it; parallel calls share one in-flight borrow and
later steps reuse the lease. Release schedules a delayed suspension; a later
borrow cancels that exact timer. The opaque reference records its provider, so
changing `SANDBOX_PROVIDER` does not migrate existing state.

The default local provider uses
`/tmp/restate-agent-sandboxes/<encoded-agentId>`. It demonstrates lifecycle and
path containment but is not a security boundary. The Modal provider uses
disposable remote compute mounted over one persistent Volume per Agent.

Sandbox commands are one-shot foreground calls returning exit code, stdout,
and stderr. Hidden background processes are not treated as durable pending
operations.

See [`docs/sandboxes.md`](docs/sandboxes.md) for provider contracts and Modal
configuration.

## Durable evaluation harness

`Evals/all` spawns all selected trials concurrently. Every trial gets a fresh
`agentId`, drives Agent, AgentSession, AgentScheduler, and AgentNotifications
through their public handlers, waits on notification revisions, and returns
code-based assertions over transcript structure, ordering, IDs, profile state,
and terminal outcomes.

The current suite covers basic completion, steering, interruption, external
cancellation, interruption with replacement input, memory, schedules, and six
guardrail/approval flows.

```sh
curl localhost:8080/Evals/all \
  --json '{"timeoutSeconds":180}'

curl localhost:8080/Evals/all \
  --json '{"cases":["steering","interruption"],"timeoutSeconds":180}'
```

The live model makes language behavior probabilistic; graders target durable
protocol structure rather than exact prose. See [`docs/evals.md`](docs/evals.md).

## Run locally

Requirements:

- Node.js 22 or newer;
- pnpm;
- Restate Server and CLI;
- `OPENAI_API_KEY`; and
- optionally Modal credentials.

Scope-based model flow control currently needs the experimental Restate
protocol features enabled on a fresh local server:

```sh
RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true \
RESTATE_EXPERIMENTAL_ENABLE_VQUEUES=true \
restate-server
```

In another shell:

```sh
pnpm install
OPENAI_API_KEY=... pnpm dev:service
restate deployments register http://localhost:9080
```

Restate ingress defaults to `http://localhost:8080`; the Admin API and Restate
UI use `http://localhost:9070`.

To use Modal:

```sh
OPENAI_API_KEY=... \
SANDBOX_PROVIDER=modal \
MODAL_TOKEN_ID=... \
MODAL_TOKEN_SECRET=... \
pnpm dev:service
```

For a production build and core service process, use `pnpm start:service`.

To start the web UI, configure Sign in with Google and `APP_PUBLIC_URL` as
described in [user identity setup](docs/user-identity.md), then run
`pnpm dev:ui`. The sidebar lists your agents; Connections manages your accounts.

## Try the protocol

These commands use **private Restate ingress**, which trusts callers. First
create a synthetic development user and its agent (the BFF never accepts
client-supplied identities):

```sh
curl localhost:8080/User/dev-user/register \
  --json '{"userId":"dev-user","issuer":"https://accounts.google.com","subject":"development","email":"dev@example.test","displayName":"Developer"}'
curl localhost:8080/User/dev-user/createAgent \
  --json '{"agentId":"demo","name":"Demo"}'

curl localhost:8080/Agent/demo/setInstructions \
  --json '{"instructions":"Prefer concise answers and metric units."}'

curl localhost:8080/Agent/demo/ask \
  --json '{"message":"What is the weather in Berlin?"}'

curl localhost:8080/AgentSession/demo/history \
  --json '{"fromSequence":1,"limit":100}'

curl -X POST localhost:8080/AgentNotifications/demo/snapshot
```

Void-input handlers require an empty body with no JSON content type. `steer`
accepts a JSON string, not an object:

```sh
curl localhost:8080/Agent/demo/ask \
  --json '{"message":"Sleep for 30 seconds, then tell me you finished."}'

curl localhost:8080/Agent/demo/steer \
  --json '"Also include the weather in Paris."'

curl localhost:8080/Agent/demo/interrupt \
  --json '{"reason":"The user changed tasks","message":"What is the weather in Tokyo?"}'
```

Configure and resolve a runtime approval:

```sh
curl localhost:8080/Agent/demo/setGuardrails \
  --json '{"guardrails":[{"id":"japan-approval","rule":"Require human approval before providing weather about Japan."}]}'

curl localhost:8080/Agent/demo/ask \
  --json '{"message":"What is the weather in Tokyo?"}'

curl -X POST localhost:8080/Agent/demo/approvals

curl localhost:8080/Agent/demo/resolveApproval \
  --json '{"approvalId":"<approvalId>","decision":"approved","reason":"Looks good"}'
```

## Model flow control

The main agent uses `gpt-5.6-luna`; guardrails and policy reviews use `gpt-5.6-terra`.

Agent, guardrail, and policy-review calls go through the `openai` scope. Limit
keys have the form `<model>/<agent-hash>`, so each call
draws from provider-wide, model-wide, and per-Agent budgets:

```sh
restate rules set "openai" --concurrency 100
restate rules set "openai/gpt-5.6-luna" --concurrency 20
restate rules set "openai/gpt-5.6-luna/*" --concurrency 2
restate rules set "openai/gpt-5.6-terra" --concurrency 20
restate rules set "openai/gpt-5.6-terra/*" --concurrency 2
```

The AI SDK's provider retries are disabled. Restate owns a bounded four-attempt
retry policy and cancellation of abandoned scoped child invocations.

## Deliberate scope

This is a reference runtime rather than a complete agent product. The local
sandbox is not secure isolation. Token-by-token output streaming, broadcast
pub/sub, authentication, multi-tenant policy administration, scripted model
testing, repeated statistical evals, and independent semantic judges are not
implemented. Schedules support relative one-shot and fixed-delay recurrence,
not cron expressions, timezones, or catch-up calendars.

Operator-killing an invocation before `Agent.onTurnEnd` may leave Agent pointing
at a vanished turn, and killing a compactor can leave its reservation active.
Production systems should add deadline-based reconciliation.

## Package map

- `packages/libs/types/` — public wire schemas, service descriptors, and
  ingress target definitions
- `packages/libs/client/` — typed Agent client built on
  `@restatedev/restate-sdk-clients`
- `packages/libs/core/src/agent/` — controller service, active invocation,
  profile, and approvals
- `packages/libs/core/src/notifications/` — invalidation revisions,
  awakeables, and long-poll subscriptions
- `packages/libs/core/src/scheduler/` — schedule state, durable timers,
  recurrence, and delivery
- `packages/libs/core/src/session/` — transcript owner, turn state machine,
  model-context projection, tools, steering, and pending operations
- `packages/libs/core/src/gateway/` — AI SDK provider integration, model
  contracts, scoped inference admission, and model-backed compaction
- `packages/libs/core/src/sandbox/` — durable workspace lifecycle, provider
  contract, and Modal adapter
- `packages/libs/core/src/eval.ts` — black-box evaluation harness
- `packages/libs/core/src/app.ts` — executable Restate endpoint
