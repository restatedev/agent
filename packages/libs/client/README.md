# @restate-agents/client

A typed HTTP client for one agent, through the Restate ingress. It runs in
Node and in the browser. Each method calls one public handler of `Agent` or
`AgentSession`.

```ts
import {createAgentClient} from "@restate-agents/client";

const agent = createAgentClient({
  ingressUrl: "http://localhost:8080",
  agentId: "demo",
});

await agent.ask("What is the weather in Berlin?");

for await (const {sequence, entry} of agent.follow()) {
  if (entry.role === "assistant") {
    console.log(sequence, entry.text);
  }
}
```

## Options

| Option | Meaning |
| --- | --- |
| `ingressUrl` | Restate ingress base URL, such as `http://localhost:8080` |
| `agentId` | The agent's key. A new ID creates an agent |
| `headers` | Sent with every request, such as `Authorization: Bearer <token>` |
| `retry` | Retry policy for idempotent calls. On by default |

## Methods

| Area | Methods |
| --- | --- |
| Conversation | `ask`, `steer`, `interrupt`, `deliver` |
| Reading | `history`, `notifications`, `watch`, `follow` |
| Profile and memory | `profile`, `updateProfile`, `searchMemories`, `readMemories`, `deleteMemory`, `toolCatalog` |
| Lifecycle | `metadata`, `children`, `retire` |
| Schedules | `schedules`, `createSchedule`, `cancelSchedule` |
| Approvals | `approvals`, `resolveApproval` |

`follow` is the one method that is not a single handler. It reads the history
from a cursor, and when it has caught up it waits for new entries with
`watch`. It keeps going until its `signal` aborts:

```ts
const stop = new AbortController();

for await (const {entry} of agent.follow({fromSequence: 1, signal: stop.signal})) {
  // ...
}
```

A network failure does not end the stream: `follow` waits and tries again.
A failed wait retries under the same idempotency key, so it joins the wait
already parked in Restate instead of starting another.

## Errors

A call that Restate rejects throws `AgentClientError`, with the HTTP
`status` and the handler's error message.

```ts
import {AgentClientError} from "@restate-agents/client";

try {
  await agent.retire();
} catch (error) {
  if (error instanceof AgentClientError) {
    console.error(error.status, error.message);
  }
}
```

The payloads and what each handler does are in
[`docs/protocol.md`](../../../docs/protocol.md). The web app uses this client
in `packages/apps/web/src/server/restate.ts`.
