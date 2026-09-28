# Development and verification

This guide covers local setup, safe change workflows, debugging, and
verification. Read [agent-guide.md](agent-guide.md) before changing runtime
semantics.

## Requirements

- Node.js 22 or newer
- pnpm
- Restate Server and CLI
- an OpenAI API key
- optionally, Modal credentials for remote sandboxes

Install dependencies:

```sh
pnpm install
```

## Start the stack

Follow [the root quickstart](../README.md#quickstart) to start a fresh private
Restate server, the core endpoint, and the optional localhost UI.

The core listens on 9080; Restate ingress is normally 8080 and its Admin API/UI
9070. `pnpm dev:service` and `pnpm dev:ui` build their required workspace
packages before starting. `pnpm dev` starts both processes. UI scripts bind to
`127.0.0.1`; copy `packages/apps/web/env.example` to `.env.local` in that package
if you need different ingress connectivity.

Configure optional MCP servers on the core process using
[MCP configuration](mcp-configuration.md). PTC is enabled by default; disable
it with `programTool` in `src/agent-config.ts`. Web search is enabled by
default and uses Tavily's keyless endpoint; Context → Web search saves an
agent-local preference.

`AGENT_MODEL_MAX_OUTPUT_TOKENS` controls the model output budget: default
`32000`, valid integers `1024` through `64000`. Truncation gets one recovery
attempt at double its recorded budget, capped at `64000`; see
[model recovery](turn-runtime.md#model-output-budgets-and-recovery).

For optional Modal sandboxes, export `SANDBOX_PROVIDER=modal`, `MODAL_TOKEN_ID`
and `MODAL_TOKEN_SECRET` into the core process. See [sandboxes](sandboxes.md).
Do not send credentials as handler arguments.

## Packaging

`docker/Dockerfile` and `docker/Dockerfile.web` are runnable packaging examples.
The latter builds Next.js standalone output and serves the local UI on port
3000. Publish container ports only on loopback for local use, for example
`-p 127.0.0.1:3000:3000`.

## Smoke test

Send directly to any agent ID on private ingress:

```sh
curl localhost:8080/Agent/demo/ask \
  --json '{"message":"What is the weather in Berlin?"}'
```

Read its conversation event log (`AgentSession.history`):

```sh
curl localhost:8080/AgentSession/demo/history \
  --json '{"fromSequence":1,"limit":100}'
```

Void-input handlers require an empty request without a JSON content type:

```sh
curl -X POST localhost:8080/Agent/demo/profile
```

Do not send `{}` to a void handler. Restate treats a JSON body as an input that
violates the void schema.

For an active-control smoke test:

```sh
curl localhost:8080/Agent/demo/ask \
  --json '{"message":"Sleep for 30 seconds, then tell me that you finished."}'

curl localhost:8080/Agent/demo/steer \
  --json '{"message":"Also include the weather in Paris."}'
```

## Validation commands

Run the relevant deterministic checks before committing an implementation change:

```sh
pnpm lint
pnpm build
pnpm test
pnpm bundle
```

CI (`.github/workflows/ci.yml`) runs the same checks on every pull request and
also builds both container images.

- `lint` runs oxlint on `packages` and checks oxfmt formatting of sources,
  tests and config files; `format` applies oxlint fixes and oxfmt. Type-checking is
  TypeScript 7 (the native `tsc`), run by `build`.
- `build` compiles the workspace and creates a production Next.js build.
- `test` runs the core and web suites.
- `bundle` creates the deployable ESM bundle, zipped as `dist/index.zip` (this
  needs the `zip` command), and catches packaging/import problems that
  type-checking alone may miss.

Also inspect:

```sh
git diff --check
git status --short
```

Do not stage unrelated files in a dirty worktree.

## Debugging map

Use the Agent conversation event log and Restate execution trace for different
questions.

### The conversation event log answers

- What did the user and assistant observe?
- In what order did AgentSession append activated input, steering,
  interruption, approvals, and terminal outcomes?
- Which tool names started and how did the batch settle?
- Did an approval, external-delivery, or lifecycle event occur?

### The Restate execution trace answers

- What exact model request and response ran?
- What raw tool input and result were used?
- Which child invocation or signal was created?
- Was an operation replayed, retried, interrupted, or cancelled?
- Which `restate.run` or handler is currently parked?

The public event log intentionally omits raw reasoning, tool arguments, and
tool results. Those details belong to the agent trajectory/working context and
runtime trace.

### Useful correlations

- `agentId` is the shared Agent and AgentSession Virtual Object key.
- `turnId` is the `AgentSession/doTurn` invocation ID.
- `toolCallId` is the stable pending-operation ID.
- `approvalId` is the tool call or guardrail approval signal identity.
- history `sequence` is the inclusive cursor position.
- a schedule's stored delayed invocation ID rejects stale firings.

## Common failures

### `Expected body and content-type to be empty`

The handler input is `void`. Send an empty POST without `--json`, `-d`, or a
JSON content type.

### Model rejects a function schema

OpenAI strict function schemas require every declared object property in the
`required` array. Built-ins get strict schemas from Zod. Prefer required
nullable fields when the model may omit a value semantically:

```ts
reason: z.string().nullable()
```

Dynamic third-party schemas use `strict: false`.

### `System messages are not allowed`

This project passes system-level prompt material through the AI SDK
`instructions` option. Do not inject a system message into the `messages`
array for provider endpoints that reject it.

### Dynamic handler does not appear

Check:

1. the handler has exact metadata key `restate.dev/agent`;
2. its value is a unique valid tool name;
3. the handler publishes JSON input schema metadata;
4. this endpoint can reach `RESTATE_ADMIN_URL`;
5. no built-in has the same name;
6. logs contain no discovery warning;
7. you started a new turn after the catalog refreshed.

The cache refresh interval is five minutes. Existing turns keep their
journaled snapshot.

### MCP tool does not appear

Check the core process's `MCP_SERVERS_JSON`, selected protocol, connectivity
and Agent tool grants. A changed connector requires a new turn. A `tokenEnv`
reference must end in `_MCP_TOKEN` and resolve in the core environment. Missing/invalid credentials
produce sanitized discovery warnings or tool failures, without an OAuth wait.

Read [MCP configuration](mcp-configuration.md) and inspect the Restate discovery
run. Never add logging that prints tokens or full provider request headers.

### An Agent remains busy

Inspect Agent state and the referenced `AgentSession.doTurn` invocation. This
compact reference
does not reconcile an operator-killed turn if it died before `onTurnEnd`.
External invocation cancellation through Restate follows the supervised
cleanup path, but a hard operator kill is a documented production gap.

### An approval repeats

Inspect the canonical approval request/resolution/cancellation events, the
current profile guardrails, and the exact proposed action. Approval is scoped
to one proposal. New protected work after steering is supposed to be evaluated
again; a later unrelated turn should not inherit a blanket approval.

### Sandbox credentials appear missing

Confirm that `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are exported into the
service process. Existing sandbox refs keep their original provider even if
`SANDBOX_PROVIDER` changes.

## Safe change checklists

### Conversation routing

When changing `ask`, `steer`, `interrupt`, or turn completion:

1. preserve natural append order in the immutable transcript;
2. preserve queued messages exactly once;
3. account for accepted-but-unconsumed steering;
4. distinguish graceful interruption from external cancellation;
5. ensure Agent active state is retired exactly once;
6. add or update a test for the full flow.

### Turn loop

When changing `session/service.ts` or `session/step.ts`:

1. keep one step bounded;
2. settle and join every spawned task;
3. drain steering only at defined step boundaries;
4. never execute a guardrail-denied batch;
5. keep pending tasks across steps;
6. preserve completed results during finalization;
7. retain the 50-step turn bound.

### History

When changing transcript storage or consumption:

1. append; never rewrite prior entries;
2. preserve monotonically increasing sequence numbers;
3. keep `fromSequence` inclusive;
4. retain lazy chunk reads and early exit;
5. preserve the one-time `openTurn` read and invocation-local append cursor;
6. publish history invalidation after appends without moving history to Agent;
7. keep shared history reads and compaction from blocking the exclusive turn;
8. treat compaction as derived context only.

### Model boundary

When changing a request or schema:

1. update Zod wire schemas and inferred types together;
2. keep tool manifests serializable, since model results are journaled;
3. use `instructions` for system-level prompt material;
4. disable hidden provider retries where Restate owns retry;
5. pass the run signal through to the provider call.

## Where to make a change

| Goal | Primary file |
| --- | --- |
| Change Agent API or controller routing | `src/agent/service.ts`, `src/agent/turns.ts` |
| Change active-turn bookkeeping/signals | `src/agent/active-turn.ts` |
| Change transcript storage | `src/session/history.ts` |
| Change invalidation subscriptions | `src/agent/notifications.ts` |
| Change instructions/guardrails | `src/agent/profile.ts` |
| Change memories | `src/agent/memories.ts` |
| Change approvals | `src/agent/approvals.ts` |
| Change sub-agents | `src/agent/sub-agents.ts` |
| Change schedules and timer delivery | `src/agent/schedules.ts` |
| Change the turn state machine | `src/session/service.ts` |
| Change one inference/tool step | `src/session/step.ts` |
| Change in-turn context compaction | `src/session/turn-compaction.ts` |
| Change models, context window, base instructions or the tool list | `src/agent-config.ts` |
| Add a built-in tool | `src/tools/*.ts`, listed in `src/agent-config.ts` |
| Change how tools are defined | `src/tools-api.ts` |
| Change tool dispatch and result projection | `src/session/tools.ts` |
| Change programmatic tool calling | `src/session/program-tool.ts`, `src/ptc/` |
| Change dynamic discovery | `src/session/dynamic-tools.ts` |
| Change provider inference | `src/model/provider.ts` |
| Change model retries/output recovery | `src/model/inference.ts` |
| Change sandbox lifecycle | `src/sandbox/turn.ts` |
| Add a sandbox provider | `src/sandbox/provider.ts` and an adapter module |
| Change public wire/domain schemas | `packages/libs/types/src/index.ts` |
| Change Agent handler contracts | `packages/libs/types/src/services.ts` |
| Change the external client | `packages/libs/client/src/index.ts` |

Paths without a package prefix are relative to `packages/libs/core`.
