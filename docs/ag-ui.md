# AG-UI

[AG-UI](https://docs.ag-ui.com) is an open protocol between agents and user
interfaces. Frontends built for it, such as CopilotKit, can talk to this
agent through one endpoint in the reference web app:

```
POST /api/ag-ui        body: RunAgentInput     response: text/event-stream
```

The adapter is `packages/apps/web/src/server/ag-ui.ts`. It translates the
agent's history with `ag-ui-events.ts`. It runs nothing itself: every turn
still runs in Restate, and the endpoint is a view of the durable conversation.

## Model

| AG-UI | This agent |
| --- | --- |
| thread (`threadId`) | agent (`agentId`); a new thread ID creates an agent |
| run | one turn, from the message it delivers to the turn's answer |
| interrupt | a pending approval; the turn is suspended on a durable signal |
| resume | `resolveApproval` for each answered interrupt |
| connect | the conversation as `MESSAGES_SNAPSHOT`, then the running turn |

A run ends with `RUN_FINISHED` when its turn answers, or with `RUN_ERROR`
when the turn fails. The result is `{turnId, status}`, where status can
also be `interrupted` or `stopped`.

## Input

The endpoint tells requests apart by what they carry:

- **Resume**: `resume` answers every interrupt of the previous run. The
  payload is `{"decision": "approved" | "rejected", "reason"?: string}`, and
  a cancelled entry rejects. An interrupt that is no longer pending, because
  someone answered it elsewhere or its turn ended, fails the run. The resume
  first sends what the turn wrote after the interrupted run ended, such as
  results of tools that ran in the same step.
- **New message**: the last message is from the user and has an ID the
  adapter did not mint. It is sent with `ask`. With
  `forwardedProps: {"mode": "steer"}` it steers the running turn instead,
  and starts a turn if none is running. With `{"mode": "interrupt"}` it is
  the reason for interrupting the running turn.
- **Connect**: anything else.

A queued message runs in the turn after the active one, and the run follows
that turn.

`HttpAgent` from `@ag-ui/client` has no reconnect transport. Point
`connect` at `run` to use this endpoint for `connectAgent()`:

```ts
const agent = new HttpAgent({url: "http://127.0.0.1:3000/api/ag-ui", threadId: "demo"});
agent.connect = (input) => agent.run(input);
```

## Events

| History entry | AG-UI events |
| --- | --- |
| user or assistant message | `TEXT_MESSAGE_START`, `_CONTENT`, `_END` |
| tools started | `TOOL_CALL_START`, `_ARGS`, `_END` per call; the arguments are the recorded input, or `{}` when it was too long to record |
| tools finished | `TOOL_CALL_RESULT` per settled call; the content is JSON: `{"status": ..., "summary"?: ...}` |
| activity | `ACTIVITY_SNAPSHOT` (`activity`) |
| progress | `ACTIVITY_SNAPSHOT` (`progress`), one per turn, replaced |
| anything else | `CUSTOM` named `restate.<type>`, with the entry as its value |

Message IDs are `seq-<sequence>`, so an entry keeps its ID across streams
and snapshots. The adapter uses the newest one a request carries to find
where to start reading.

## What Restate adds

- **Closing the stream does not stop the turn.** The turn runs in Restate.
  A client that reconnects gets the conversation and follows the turn if it
  is still running.
- **An interrupt holds no process.** The turn waits on a durable signal,
  for days if needed, through crashes and new versions of the service. A
  client that reconnects sees the open interrupt again.
- **The history is the source of truth.** A run reads what the turn
  recorded, so every client sees the same conversation.

## Limits

- **No token streaming.** Model calls are journaled whole, so an answer
  arrives as one `TEXT_MESSAGE_CONTENT`.
- **No tool output.** History records a tool call's name, input and status,
  not its result. An input longer than 4,000 characters of JSON is not
  recorded either, and its arguments show as `{}`.
- **Server-owned history.** The adapter reads only the new user message
  from `messages`. Client `tools`, `context` and `state` are ignored. The
  `restate-agent` skill describes how to add frontend tools
  (`plugins/restate-agent/skills/restate-agent/references/client-tools.md`).
- **No sub-agent events.** A sub-agent's work is in its own history. The
  parent's `createSubAgent` call shows as an ordinary tool call.
