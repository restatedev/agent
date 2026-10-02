# Architecture

The reference separates a responsive controller from a long-running durable
turn. All conversation-scoped objects use the same `agentId`; a caller can
send `Agent/{agentId}/ask` immediately. No account registration is required.

## State ownership

| Component | Durable state and responsibility |
| --- | --- |
| `Agent` | Active invocation ID, queued input, steering reconciliation, profile, memories, approvals, schedules, notification watermarks, metadata and child directory |
| `AgentSession` | Append-only conversation history, summary checkpoint, sandbox reference, exclusive `doTurn` execution |

A turn is one `AgentSession.doTurn` invocation. Its invocation ID is its
`turnId`. The model plus harness form the operational agent; `Agent` is the
controller, not the model loop.

## One request

1. `Agent.ask` starts a turn while idle or stores a pending user entry while busy.
2. Starting snapshots instructions, guardrails, the memory count, tool grants, web search
   preference and configured MCP server references. It sends `doTurn` one way.
3. `AgentSession` opens history once and appends the activated entries. It builds
   model context from the summary checkpoint and remaining conversation.
4. Each step gets a model proposal, gates it through guardrails, and executes
   an allowed tool batch or publishes text. Foreground tools are joined within
   the step; pending tools can outlive a step.
5. Completion reconciles with `Agent.onTurnEnd`. Only the matching invocation
   can retire the current turn and start queued work.

The controller's exclusive lock is short-lived. It never waits for the whole
turn. A parent controller starts a child turn and returns its invocation ID;
its own session waits for that child's outcome without holding the parent lock.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant A as Agent (controller)
  participant S as AgentSession (turn)
  participant M as Model and guardrails
  participant T as Tools

  C->>A: ask("Compare weather in Berlin, Paris and Rome")
  A-)S: doTurn(profile snapshot and input), one way
  A-->>C: started, turnId
  S->>S: append input to history, build context

  S->>M: model call
  M-->>S: proposal: three tool calls
  opt guardrails configured
    S->>M: evaluate proposed tool batch
    M-->>S: allow
  end
  Note over S,T: Allowed foreground calls run concurrently inside the turn
  par Berlin
    S->>T: getWeather(Berlin)
    T-->>S: result
  and Paris
    S->>T: getWeather(Paris)
    T-->>S: result
  and Rome
    S->>T: getWeather(Rome)
    T-->>S: result
  and new input while tools run
    C->>A: steer("Use Fahrenheit")
    A-)S: durable steering signal addressed to turnId
    A-->>C: accepted
  end
  Note over S,T: Restate journals durable operations; recovery reuses recorded results

  S->>S: retain tool results, consume steering
  S->>M: next model call with results and steering
  M-->>S: proposed final answer
  opt guardrails configured
    S->>M: evaluate proposed answer
    M-->>S: allow
  end
  S->>A: onTurnEnd(outcome)
  Note over A: Reconcile late input, retire matching turn, dispatch queued work
  A-->>S: reconciled outcome
  S->>S: append final outcome to history
  S-)A: publish(history)

  C->>A: watch(afterRevision), long poll
  A-->>C: changed topic revisions
  C->>S: history(fromSequence)
  S-->>C: new entries and next sequence
```

The diagram shows a successful tool batch and final answer. Model/tool steps
can repeat, and a guardrail can instead block a proposal or wait for approval.
`getWeather` is a synthetic demo tool. The client can watch throughout the
turn; history appends publish changes as work progresses, not just at the end.

These arrows describe logical calls through Restate. `doTurn` is dispatched
one way so the controller can return immediately. Steering, interruption and
approval decisions use durable signals addressed to that invocation's
`turnId`. Normal completion uses a request/response call to `onTurnEnd` so the
session can record the controller's reconciled outcome. A queued successor
cannot execute until the current exclusive `doTurn` finishes.

The model and tool lanes represent work owned by the turn, not additional
Virtual Objects. Built-in tools run as in-process functions; model requests,
MCP calls and sandbox operations use journaled effects. Discovered Restate
tools use durable RPCs. Recovery reuses recorded results, but an external
effect that completed before its result was recorded may run again; remote
side effects still need provider-level idempotency.

For exact message shapes, see the [protocol](protocol.md). For the loop's
approval, pending-work and cancellation paths, see the [turn runtime](turn-runtime.md).

## Control and history

![Animation: after a turn the older messages are summarized while the 8 most recent stay verbatim; the log keeps growing and the model sees the summary plus recent messages](images/compaction.svg)

Busy `ask` queues FIFO. `steer` drains queued input into an ordered signal for
the active turn and preserves current tool work. `interrupt` cancels unfinished
work, joins cleanup, and makes one tool-free finalization call. Its optional
replacement message belongs to a successor turn.

Every terminal outcome carries the consumed steering count so late input can
be recovered exactly. History is append-only. Compaction writes a summary
checkpoint; it does not rewrite the event log. A turn that outgrows the
model's window also compacts its own working context, which never touches the
log; see [turn runtime](turn-runtime.md#working-context-compaction). Raw tool I/O and internal
execution traces are distinct from public conversation events.

## Context and delegation

Memories live on each Agent as an index in one state key (`memory/index`:
IDs such as `mem0` with a short description) and one key per memory's
content. Agent uses lazy state, so a handler loads only the keys it touches.
A turn is told only how many memories exist. The model finds relevant ones
with `searchMemories` (a local MiniSearch over the index descriptions, run by a
shared Agent handler), reads content with `readMemories` and changes memories
with `manageMemory`. Model context therefore does not grow with the number of
memories.
Unrelated agent IDs share no memory.

The parent stores its child directory; each child stores its parent ID and
its own profile, history and sandbox. Creation copies the parent's instructions,
guardrails and effective tools, then applies any narrower selection. A child
starts with an empty memory of its own.
The copy does not follow later parent changes. Children cannot create children
or schedules; the parent initiates their tasks and follow-ups. Tool waits attach
to the exact child turn. Cleanup never interrupts an unrelated successor turn.
Retirement stops work, clears the profile, memories and approvals, and releases
resources, while retained history remains.

## Scheduling

Each schedule is a delayed `Agent/{agentId}/fire` invocation that routes its
message like any external delivery. Busy policy is explicit: queue, steer or interrupt. Repeating
schedules rearm a durable timer; obsolete timer invocations are ignored.
This example does not create a fresh agent for each occurrence. See
[schedules](schedules.md) for the contract and cancellation semantics.

## External effects and credentials

Model calls, sandbox operations and MCP HTTP calls execute inside durable
`restate.run` effects. Process-local caches are optimizations, never authority.
Restate journals completed results; an effect interrupted before recording its
result can execute again. Remote idempotency still depends on the provider.

MCP endpoints are operator configuration. Turn snapshots carry endpoint and
credential-reference metadata; environment tokens resolve only inside HTTP
effects. There is no OAuth flow, token store, encryption key or credential
entry UI. [MCP configuration](mcp-configuration.md) explains this boundary.

## Local UI and invalidation

The Next.js UI is an optional local operator interface. It chooses a conversation
by `?agent=`, proxies supported operations, checks the Host of every request
against loopback or `APP_PUBLIC_URL` (DNS rebinding) and checks the Origin of
writes.
It has no authentication or tenant isolation. Its scripts bind to `127.0.0.1`.

The server captures an Agent notification watermark before loading history,
profile, approvals, metadata, children and schedules. It drains history pages,
then long-polls changes and re-reads only changed topics. `profile` invalidates
metadata and children too. Browser
merging deduplicates sequences and never moves its history cursor backward.
Each mounted conversation owns one cancellable poll; switching is navigation.
