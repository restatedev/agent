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

Scope-based model flow control is used by the example. Enable its Restate
protocol features when starting a fresh local server:

```sh
RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true \
RESTATE_EXPERIMENTAL_ENABLE_VQUEUES=true \
restate-server
```

Start the endpoint in another shell:

```sh
export OPENAI_API_KEY=...
pnpm dev
```

The endpoint listens on port 9080 by default. Register it:

```sh
restate deployments register http://localhost:9080
```

Restate ingress is normally `http://localhost:8080`, and the local Admin
API/UI is `http://localhost:9070`.

To use Modal:

```sh
export SANDBOX_PROVIDER=modal
export MODAL_TOKEN_ID=...
export MODAL_TOKEN_SECRET=...
pnpm dev
```

Shell variables must be exported so the Node process receives them. Never
commit credentials or local launch scripts containing credentials.

See [sandboxes.md](sandboxes.md) for optional Modal settings and lifecycle
behavior.

## Smoke test

Start one Agent:

```sh
curl localhost:8080/Agent/demo/ask \
  --json '{"message":"What is the weather in Berlin?"}'
```

Read its transcript:

```sh
curl localhost:8080/Agent/demo/history \
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
  --json '"Also include the weather in Paris."'
```

`steer` accepts a JSON string, not `{message: ...}`.

## Validation commands

Run all three before committing an implementation change:

```sh
pnpm lint
pnpm build
pnpm bundle
```

- `lint` runs Biome across source and Markdown.
- `build` type-checks the workspace.
- `bundle` creates the deployable ESM bundle and catches packaging/import
  problems that type-checking alone may miss.

Also inspect:

```sh
git diff --check
git status --short
```

Do not stage unrelated files in a dirty worktree.

## Durable evals

The `Evals/all` handler drives fresh Agents through the public protocol and
runs selected cases concurrently:

```sh
curl localhost:8080/Evals/all \
  --json '{"timeoutSeconds":180}'
```

Run one or a few cases while iterating to reduce model cost:

```sh
curl localhost:8080/Evals/all \
  --json '{"cases":["steering","interruption"],"timeoutSeconds":180}'
```

The `context-reduction` case uses one cheap-model request and avoids a full
agent Turn:

```sh
curl localhost:8080/Evals/all \
  --json '{"cases":["context-reduction"]}'
```

Evals use probabilistic live models. A failed language-quality assertion may
need careful transcript inspection or a repeat. Protocol ordering, correlation
IDs, state, and handler decisions should remain deterministic.

See [evals.md](evals.md) for case contracts and known gaps.

## Debugging map

Use the Agent transcript and Restate journal for different questions.

### Agent history answers

- What did the user and assistant observe?
- In what order did Agent handlers observe queueing, steering, interruption,
  approvals, and terminal outcomes?
- Which tool names started and how did the batch settle?
- Did a profile, approval, schedule, or lifecycle event occur?

### Restate observability answers

- What exact model request and response ran?
- What raw tool input and result were used?
- Which child invocation or signal was created?
- Was an operation replayed, retried, interrupted, or cancelled?
- Which `restate.run` or handler is currently parked?

The transcript intentionally omits raw reasoning, tool arguments, and tool
results.

### Useful correlations

- `agentId` is the Agent and Sandbox Virtual Object key.
- `turnId` is the `Turn/run` invocation ID.
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
7. you started a new Turn after the catalog refreshed.

The cache refresh interval is five minutes. Existing Turns keep their
journaled snapshot.

### An Agent remains busy

Inspect Agent state and the referenced Turn invocation. This compact reference
does not reconcile an operator-killed Turn if it died before `onTurnEnd`.
External invocation cancellation through Restate follows the supervised
cleanup path, but a hard operator kill is a documented production gap.

### An approval repeats

Inspect the canonical approval request/resolution/cancellation events, the
current profile guardrails, and the exact proposed action. Approval is scoped
to one proposal. New protected work after steering is supposed to be evaluated
again; a later unrelated Turn should not inherit a blanket approval.

### Sandbox credentials appear missing

Confirm that `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are exported into the
`pnpm dev` process. Existing sandbox refs keep their original provider even if
`SANDBOX_PROVIDER` changes.

## Safe change checklists

### Conversation routing

When changing `ask`, `steer`, `interrupt`, or Turn completion:

1. preserve natural append order in the immutable transcript;
2. preserve queued messages exactly once;
3. account for accepted-but-unconsumed steering;
4. distinguish graceful interruption from external cancellation;
5. ensure Agent active state is retired exactly once;
6. add or update an eval for the full flow.

### Turn loop

When changing `turn.ts` or `turn-step.ts`:

1. keep one step bounded;
2. settle and join every spawned task;
3. drain steering only at defined step boundaries;
4. never execute a guardrail-denied batch;
5. keep pending tasks across steps;
6. preserve completed results during finalization;
7. retain both tool and step budgets.

### History

When changing transcript storage or consumption:

1. append; never rewrite prior entries;
2. preserve monotonically increasing sequence numbers;
3. keep `fromSequence` inclusive;
4. retain lazy chunk reads and early exit;
5. close the empty-read/watch registration race;
6. keep shared watchers from blocking exclusive writers;
7. treat compaction as derived context only.

### Model boundary

When changing a request or schema:

1. update Zod wire schemas and inferred types together;
2. preserve serializable manifests across the gateway;
3. use `instructions` for system-level prompt material;
4. disable hidden provider retries where Restate owns retry;
5. preserve cancellation propagation;
6. consider model and per-Agent flow-control keys.

## Adding an eval

Add the case ID to `EvalCaseIdSchema`, implement a generator scenario in
`eval.ts`, and register it in the internal case table used by `all`.

Prefer assertions over:

- handler decisions;
- transcript event types and ordering;
- stable IDs and correlations;
- durable profile or schedule state;
- terminal status.

Avoid exact prose assertions. Use a focused cheap-model contract when the
behavior can be tested without manufacturing many full Turns.

## Where to make a change

| Goal | Primary file |
| --- | --- |
| Change Agent API or controller routing | `src/agent.ts` |
| Change active-turn bookkeeping/signals | `src/agent-turn.ts` |
| Change transcript storage/watch | `src/agent-history.ts` |
| Change instructions/memories/guardrails | `src/agent-profile.ts` |
| Change approvals | `src/agent-approval.ts` |
| Change schedules | `src/agent-schedules.ts` |
| Change the Turn state machine | `src/turn.ts` |
| Change one inference/tool step | `src/turn-step.ts` |
| Add a built-in tool | `src/agent-tools.ts` |
| Change dynamic discovery | `src/dynamic-tools.ts` |
| Change provider inference | `src/model.ts` |
| Change model admission/retries | `src/model-gateway.ts` |
| Change sandbox lifecycle | `src/sandbox.ts` |
| Add a sandbox provider | `src/sandbox-provider.ts` and an adapter module |
| Change wire/domain schemas | `src/types.ts` |
| Add protocol coverage | `src/eval.ts` |

Paths above are relative to `packages/libs/example`.
