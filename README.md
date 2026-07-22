# Restate durable agent reference

A deliberately small reference implementation of an agentic application on
Restate. It separates durable conversation control, turn supervision, model
access, and the concrete agent loop without hiding them behind a framework.

```mermaid
flowchart LR
  User -->|"ask / steer / interrupt"| Agent["Agent Virtual Object\nkeyed by agentId"]
  Agent -->|"cheap route-message run"| Router["GPT-4o mini"]
  Agent -->|"one-way run"| Turn["Turn service"]
  Agent -.->|"control / approval signals"| Turn
  Turn --> Loop["agentLoop"]
  Loop -->|"scoped invocation"| Gateway["ModelGateway service"]
  Gateway -->|"durable model run"| Model["agent model"]
  Loop -->|"spawn + durable run"| Tools["local tools in parallel"]
  Tools -->|"private approval request"| Agent
  Turn -->|"one-way append outcome"| Agent
```

## Why this structure

- `Agent` is the durable controller. Its exclusive handlers serialize changes
  to the active turn, pending messages, and conversation history for one
  `agentId`. It coordinates three independent components: `agent-turn.ts` owns
  turn state and signal lifecycle, `agent-history.ts` owns the durable
  transcript, and `agent-approval.ts` owns pending human approvals.
- `Turn` is stateless. One invocation supervises one agent turn and races the
  agent loop against interrupt and steering signals.
- `agentLoop` has one small boundary: `{ agentId, turnId, messages }` in and a
  `completed | failed` result out. It owns self-contained tools—their model
  descriptions, input schemas, and local durable implementations—and projects
  serializable manifests for the model gateway.
- `model.ts` owns provider-specific inference and the shared model contracts. It
  reconstructs AI SDK tool definitions from the loop's manifests, while
  deliberately receiving no executors. A cheap model routes messages that
  arrive mid-turn.
- `model-gateway.ts` is the Restate boundary for full agent inference. It owns
  scoped admission, limit keys, retries, and cancellation propagation before
  delegating the provider call to `model.ts`.

The controller stores only user-facing history. Tool calls and intermediate
model steps stay in Restate's invocation journal and observability tools. A
turn appends exactly one structured outcome: `completed`, `interrupted`, or
`failed`.

## Controller handlers

| Handler | Input | Behavior |
| --- | --- | --- |
| `ask` | `{ message: string }` | Returns the `start`, `steer`, `interrupt`, or `queue` decision, affected turn invocation ID, and queue/steering stats. |
| `history` | void | Returns the complete durable transcript plus messages waiting for the next turn. Entries distinguish user messages, interruption events, and terminal turn summaries. |
| `append` | turn outcome | Ingress-private completion path used by `Turn`; ignores stale or duplicate turn IDs. |
| `interrupt` | reason string | Records an interruption event, resolves the active turn's interrupt signal, and returns immediately. |
| `steer` | instruction string | Appends the instruction and resolves the active turn's steering signal. |
| `approvals` | void | Returns the human approvals currently waiting on this agent. |
| `resolveApproval` | `{ approvalId, decision, reason? }` | Removes a pending approval and signals its waiting tool with `approved` or `rejected`. |

A successful interruption is visible immediately as
`{ role: "event", type: "interrupt", turnId, reason }`. The later turn outcome
records whether the turn actually ended as interrupted or won a completion
race.

Repeated resolutions of the `steering` signal form a durable queue. Each
successive `signal("steering")` consumes the next instruction in order.
The controller tracks how many signals it sent, while each turn reports how
many it consumed. If normal completion wins the race with a steer, the
unconsumed instruction moves behind that outcome and runs through the normal
queued-turn path instead of being stranded in history. An explicit interrupt
supersedes outstanding steering.

The classifier uses GPT-4o mini directly from the exclusive `Agent` handler and
falls back to `queue` on failure, so an accepted message is never lost. A real
client with explicit stop and edit controls should call `interrupt` and `steer`
directly and skip intent classification.

## Durability and failure behavior

- Starting a turn and reporting its outcome are one-way Restate sends.
- Each full model round is a scoped `ModelGateway` invocation containing one
  durable `run` step. Restate owns a bounded four-attempt retry policy; the
  AI SDK's internal retries are disabled.
- The loop carries AI SDK response messages into the next model call. This
  preserves reasoning and tool-call state while OpenAI response storage is
  disabled.
- If a model round emits several independent tool calls, `agentLoop` uses
  Restate's [concurrent task primitives](https://docs.restate.dev/develop/ts/concurrent-tasks)
  to spawn all local tool `run` steps before joining them. Restate journals
  their concurrent execution and preserves deterministic replay.
- The `humanApproval` tool registers its request as Agent state, then suspends
  on a Turn-scoped signal named from the stable model tool-call ID. Approval,
  rejection, steering, and interruption all leave an explicit durable trail;
  abandoned requests are cleaned up idempotently.
- Deterministic configuration and OpenAI 4xx request errors fail immediately.
  Transient transport, timeout, rate-limit, conflict, and 5xx errors retry.
- Invocation cancellation aborts model I/O, joins the spawned loop, retires the
  controller's active turn, and is rethrown so Restate records cancellation.
- The complete transcript remains durable, while the model sees only the 40
  most recent usable messages. Interrupted and failed outcome text is not
  misrepresented as an assistant answer.
- The loop stops after eight model rounds instead of running indefinitely.

## Model flow control

Only full agent inference uses the scoped gateway. Routing stays directly in
the controller because it is a small, latency-sensitive decision rather than
part of the agent loop.

`ModelGateway` calls use scope `openai` and a two-level limit key:
`gpt-5.6-terra/<agent-hash>`. Each invocation therefore draws from three
budgets at once:

- `openai` — all agent-model traffic to the provider
- `gpt-5.6-terra` — traffic for that model
- `<agent-hash>` — concurrent inference for one agent

For example:

```sh
restate rules set "openai" --concurrency 100
restate rules set "openai/gpt-5.6-terra" --concurrency 20
restate rules set "openai/gpt-5.6-terra/*" --concurrency 2
```

The constant provider scope is intentionally simple and gives this example a
single provider-wide budget. At very high scale, use a higher-cardinality scope
such as tenant or account to avoid concentrating scheduling on one partition.

## Run locally

Requirements: Node.js 22 or newer, pnpm, a local Restate Server and CLI, and an
OpenAI API key. Restate's [quickstart](https://docs.restate.dev/quickstart)
covers installing the server and CLI.

Restate's [scope-based flow control](https://docs.restate.dev/services/flow-control)
is currently opt-in and must be enabled on a fresh cluster:

```sh
RESTATE_EXPERIMENTAL_ENABLE_PROTOCOL_V7=true \
RESTATE_EXPERIMENTAL_ENABLE_VQUEUES=true \
restate-server
```

In another shell, start the service endpoint:

```sh
pnpm install
OPENAI_API_KEY=... pnpm app-dev
```

With the service endpoint running, register it with Restate:

```sh
restate deployments register http://localhost:9080
```

Then invoke the `Agent` Virtual Object under any `agentId`, such as `demo`:

The `ask` schema defaults a missing `message` to: “What is the weather in the
top 10 European capitals? Also sleep for 4 minutes.”

```sh
curl localhost:8080/Agent/demo/ask \
  --json '{"message":"What is the weather in Berlin?"}'

curl -X POST localhost:8080/Agent/demo/history

curl localhost:8080/Agent/demo/steer \
  --json '"Steer toward a one-sentence answer"'

curl localhost:8080/Agent/demo/interrupt \
  --json '"Stop; the user changed their mind"'
```

An idle agent returns a response shaped like:

```json
{
  "decision": "start",
  "turnId": "inv_...",
  "stats": {"pendingMessages": 0, "steeringSignals": 0}
}
```

To keep a turn alive while trying steering, ask the agent to use its durable
sleep tool and redirect it from another shell:

```sh
curl localhost:8080/Agent/demo/ask \
  --json '{"message":"Sleep for 30 seconds, then tell me that you finished"}'

curl localhost:8080/Agent/demo/steer \
  --json '"Do not wait any longer; answer immediately"'
```

The steering signal interrupts the pending Restate timer and restarts the agent
loop with the new instruction in its context.

To try human approval, explicitly ask the model to use the approval tool:

```sh
curl localhost:8080/Agent/demo/ask \
  --json '{"message":"Before answering, use humanApproval to ask whether you may continue."}'

curl -X POST localhost:8080/Agent/demo/approvals

curl localhost:8080/Agent/demo/resolveApproval \
  --json '{"approvalId":"<approvalId>","decision":"approved","reason":"Looks good"}'
```

`approvals` returns the `approvalId`, originating Turn invocation ID, and the
model's question. A rejection is delivered to the model as a normal completed
tool result, allowing it to explain or choose a different action.

The Restate UI at `http://localhost:9070` shows the invocation tree, durable
model/tool steps, retries, and signals. See Restate's
[HTTP invocation guide](https://docs.restate.dev/services/invocation/http) for
request-response, one-way send, attach, and cancellation variants.

## Project map

- `packages/libs/example/src/agent.ts` — durable conversation controller
- `packages/libs/example/src/agent-approval.ts` — pending human approvals and signal delivery
- `packages/libs/example/src/turn.ts` — turn lifecycle and signal supervision
- `packages/libs/example/src/agent-loop.ts` — bounded model/tool loop and local tools
- `packages/libs/example/src/model.ts` — model protocol, provider calls, and router
- `packages/libs/example/src/model-gateway.ts` — scoped model-call admission and retries
- `packages/libs/example/src/types.ts` — wire schemas and domain types
