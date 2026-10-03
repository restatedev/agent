# Pi Durable on Restate: one run per invocation

Status: exploratory design note. Not a decision. It records one approach and
its costs so it can be compared with alternatives.

## Context

[Pi Durable](https://earendil.com/posts/pi-durable/)
(`@earendil-works/pi-durable` 1.0.0) is Earendil's experimental harness for
long-running agent applications. It implements its own durability. Every
model request, tool call and compaction is a task: a state machine whose
checkpoints are committed to a pluggable `Storage`. After a crash, reopening
the storage resumes each task from its last checkpoint.

This note explores replacing Pi's engine with Restate while keeping Pi's
programming surface. The engine here means its task scheduler, its single
commit line and its checkpoint recovery. The surface means extensions, tools,
hooks, conversations, the inbox and `pi-ai` model access. The target runtime
is the generator SDK (`@restatedev/restate-sdk-gen`). The shape follows this
repository's reference agent: one Restate invocation runs a whole run and
loops inside it.

Terms follow Pi:

- **Turn**: one model response and its tool calls.
- **Run**: the turns from an input to its final answer. A conversation is
  busy while a run is going.

## How Pi Durable works today

Summarized from the 1.0.0 package source (`dist/`) and README.

### Embedding

Pi Durable is a library that lives inside one host process.

```text
host process
 ├─ supplies: registry (code), models (pi-ai), env (tool execution), settings (live getters), now, onReport
 └─ Harness ── Session ── Storage
      │          │          └─ persistence boundary: atomic commit(writes), mintId, scans
      │          └─ the single mutation line: serialized commits, document cache, commit publication
      └─ TaskScheduler + Submissions + views; Conversation handles hold no state
```

- Storage holds data and the host holds code. A conversation stores its
  extensions, tools and model by name in `pi.agent`. They are resolved
  against the live registry each time they are used.
- One storage is one harness, and one process owns it. There is no
  cross-process locking.
- Backends: memory, SQLite (WAL, `synchronous=NORMAL`) and JSONL. Portable
  cores let these run in Bun or Cloudflare Durable Objects.

### Initialization

1. `Harness.open(storage, options, context)` checks that the registry contains
   the built-in tasks (`pi.generation`, `pi.tool`, `pi.compaction`).
2. One recovery commit scans every live task into memory and turns each
   `running` task back into `pending`. A reconcile then reapplies abort marks
   that a crash left half-propagated.
3. Scheduling stays off. The host reinstalls its extensions and calls
   `resume()`, or submits or waits, which also resumes. A task whose
   definition is not installed is `blocked`. It has not failed.

### Execution

- The scheduler reserves eligible tasks in one commit and runs their phase
  handlers concurrently in-process.
- A phase handler is an `async` function. It must commit a new checkpoint or
  an outcome. Returning without durable progress faults the task.
- Phases also commit partway through:
  - tool intent, before a tool executes;
  - streamed model partials, at most every 100 ms;
  - tool output progress.
- Waits park the task record (`waiting on [ids]`). Timers are in-process
  `setTimeout`s against absolute deadlines.

### Recovery

| Failure | Behavior |
| --- | --- |
| Crash | The current phase of every live task re-runs from its last checkpoint. |
| `close()` | Seals admission and joins invocations without writing outcomes. For tasks, a close is the same as a crash. |
| `StorageRejected` | Nothing was committed. The transaction is discarded. |
| Other error after storage admission | The Session is poisoned and must be closed and reopened. |
| Duplicate client request | `requestId` deduplicates per conversation. |
| Code version skew | Task definitions carry a `version` and a `migrate` function. A missing definition leaves the task `blocked`. |

Phases must be safe to repeat up to their next commit. The built-in tasks meet
this in four ways:

- A model request is resubmitted, and a stored partial becomes an aborted
  entry.
- A tool reruns only when it is marked `replay: "safe"`. Otherwise its result
  is "interrupted and may have partially run".
- Sleeps use absolute deadlines.
- Hook decisions are memoized.

### Host obligations Pi does not enforce

1. Exactly one process may own a storage.
2. Supervision. Nothing restarts a dead harness.
3. A process must be alive for timers such as retry backoff and deferred
   polls to fire.
4. The host must reinstall the same code before calling `resume()`.
5. Durability is whatever the backend provides.

Restate already provides all five of these.

## Approach

**One run is one Restate invocation that loops inside. Concurrency inside the
run uses the generator SDK's in-invocation primitives.**

- `restate.spawn` runs a run's tool calls and background compaction
  concurrently.
- `restate.select` races each wait against an interrupt signal.
- Restate's journal replaces Pi's checkpoints. Pi's scheduler, memos, intent
  checkpoints and reopen scan are removed.

### Isolation

Each entity, such as a user or workspace, has its own key namespace
(`entity/conversationId`). Conversations of different entities never share an
object or a lock. `restate.scope(entity)` can add fairness per entity. This is
experimental and requires restate-server 1.7+ with the protocol v7 and
vqueues flags.

### Objects

| Pi concept | Object (keyed `entity/conversationId`) | Reference agent |
| --- | --- | --- |
| Inbox, submissions, `pi.agent`, run status | `PiConversation`, the controller. Exclusive handlers are short. | `Agent`, `agent/active-turn.ts` |
| Generation chain, tool tasks, compaction, transcript, conversation documents | `PiTurn`. Its exclusive `run` is one invocation per run. | `AgentSession.doTurn` |

### Control flow

- **`submit` while idle**: places the input, sends `PiTurn.run` one way, and
  stores the invocation ID.
- **`submit` while busy**, depending on Pi's inbox mode:
  - *steer*: delivered to the running invocation as a `steering` signal
    batch, as in the reference agent's `steer()`.
  - *follow-up*: queued in the controller.
  - *write* (reset or an external entry): delivered as a typed steering item
    and applied at the next boundary.
- **`abort`**: sends an `interrupt` signal. Restate cancellation remains the
  backstop for runs that are stuck.
- **`onTurnEnd(outcome)`**: called once per run. It settles the run's
  submissions and recovers steering the run did not consume (the outcome
  carries a consumed count). It then starts the next run from the queue.
  Only the invocation ID the controller recorded may retire the active run.
- **`requestId`** maps to the ingress idempotency key on `submit`.

## The run loop

```ts
*run(input: RunInput) {
  const t = transcript();
  t.append(input.placed);
  const ext = registry.resolve(input.agent);
  const interrupt = restate.signal<string>("interrupt");       // created once, raced at every wait
  const steering = steeringInbox();                            // signal batches from the controller
  let compaction: restate.Task<Summary> | undefined;
  try {
    for (let step = 0; step < input.maxSteps; step++) {
      if (needsBlockingCompaction(t)) t.placeSummary(yield* compact(t, ext));
      else if (!compaction && needsBackgroundCompaction(t)) compaction = restate.spawn(compact(t, ext));

      const sections = yield* restate.run(() => renderSections(ext, t.view()), {name: "sections"});
      const reply = yield* untilInterrupted(modelRequest(input, t, sections), interrupt);
      if (reply.interrupted) return yield* endRun(t, {status: "unanswered", reason: "aborted"});
      t.append(assistant(reply.value));

      const calls = toolCalls(reply.value);
      if (calls.length === 0) {                                // Pi's `final` boundary
        const next = yield* ext.onYield(reply.value);
        if (next === undefined) return yield* endRun(t, {status: "done"});
        t.append(user(next));
        continue;
      }
      const round = yield* untilInterrupted(toolRound(ext, calls, input.settings), interrupt);
      if (round.interrupted) return yield* endRun(t, {status: "unanswered", reason: "aborted"});
      for (const r of round.value) t.append(toolResult(r));

      // Pi's `postTools` boundary
      if (compaction?.settled) t.placeSummary(yield* compaction);
      t.append(steering.drain());
      const control = controlsOf(round.value);                 // terminate, handoff, addTools
      if (control.terminate || control.handoff) return yield* endRun(t, {status: "done"}, control);
    }
    return yield* handOver(t);                                 // step bound reached: continue as new
  } finally {
    if (compaction) {
      compaction.interrupt();
      yield* restate.allSettled([compaction]);
    }
  }
}

function* untilInterrupted<T>(op: restate.Operation<T>, interrupt: restate.Future<string>) {
  const task = restate.spawn(op);
  const {tag, future} = yield* restate.select({done: task, interrupt});
  if (tag === "done") return {interrupted: false as const, value: yield* future};
  task.interrupt();
  yield* restate.allSettled([task]);
  return {interrupted: true as const};
}
```

`modelRequest` contains Pi's retry and deferred-response handling:

- Retry backoff becomes `restate.sleep`.
- A deferred (batch) response becomes `restate.sleep` followed by a journaled
  poll. The invocation suspends while it waits.
- A context overflow triggers an inline compaction and a retry.

## Tools

```ts
function* toolRound(ext: Ext, calls: ToolCall[], settings: Settings) {
  if (isSequential(ext, calls, settings)) {
    const out = [];
    for (const call of calls) out.push(yield* toolCall(ext, call));
    return out;
  }
  const tasks = calls.map((call) => restate.spawn(toolCall(ext, call)));
  try {
    return yield* restate.all(tasks);         // toolCall returns tool errors as values
  } finally {
    for (const task of tasks) task.interrupt();
    yield* restate.allSettled(tasks);
  }
}

function* toolCall(ext: Ext, call: ToolCall) {
  const tool = ext.tool(call.name);
  const decision = yield* ext.beforeTool(call);              // generator hooks
  if (decision.block) return blocked(call, decision.block);
  const retry = tool.replay === "safe" ? toolRetry : {maxAttempts: 1};
  try {
    const result = yield* restate.run(
      ({signal}) => tool.execute(decision.args, plainApi(signal), ctx),
      {name: call.name, retry},
    );
    return yield* ext.afterTool(call, result);
  } catch (e) {
    if (e instanceof TerminalError) return interrupted(call); // "may have partially run"
    throw e;
  }
}
```

- **Replay semantics.** `replay: "unsafe"` maps to a per-run retry policy of
  `maxAttempts: 1`. A crash during the closure counts as an attempt, so an
  unsafe tool never runs twice. Pi's intent checkpoint is not needed.
- **Hooks** (`beforeTool`, `afterTool`, `beforeRequest`, `onYield`,
  `beforeCompact`) become generator operations. A hook can then wait durably,
  for example on an awakeable for human approval. In Pi Durable that needs a
  custom task. Memos are not needed because the journal records each
  decision.
- **Plain tools** (`read`, `bash`, `edit`, `write`, MCP, HTTP) run unchanged
  inside `restate.run` with a reduced API: `env`, `signal`, `output`,
  `details` and a pre-resolved agent.
- **Harness tools** need rewriting as generators. These are tools that call
  `api.commit`, `createTask`, `waitForTask` or `conversation`, for example to
  spawn subagents or write documents. `api.commit(tx => …)` becomes
  `yield* api.commit(function* (tx) {…})` and writes to the run's own state.
  Writes to other conversations become calls to those objects.

## Mapping summary

| Pi Durable | Restate, one run per invocation |
| --- | --- |
| `pi.generation` phases (prepare, request, retry, poll, tools) | Straight-line loop body. The journal is the checkpoint. |
| Generation handover between turns | The next loop iteration |
| `pi.tool` tasks with `waiting`/`allSettled` | `restate.spawn` + `restate.all`. Sequential mode is a loop. |
| `pi.compaction`, blocking or background | Inline, or spawned across steps and placed at a boundary |
| Abort marks and bottom-up abort handlers | An interrupt signal raced at every wait. Spawned work is joined in `finally`. |
| In-process timers | `restate.sleep`, with suspension |
| Memos, intent checkpoints, partial conversion, reopen scan | Not needed |
| Task scheduler and single commit line | Not needed. The run writes its own object's state. |
| Inbox boundaries (`postTools`, `final`) | Boundaries inside the loop. Steering is drained at `postTools`. |
| `requestId` | Ingress idempotency key |
| Task `version`/`migrate` | The run is pinned to its deployment |
| Subagents (conversations owned by a tool call) | Same object pair under a child key. Awaited calls propagate cancellation. |

## State and visibility

- **Transcript**: append-only and stored in chunked, lazy state keys, as in
  `session/history.ts`. Shared handlers serve `entries`, `context`,
  `snapshot` and `watch` while a run is active.
- **Atomic visibility**: Pi shows nothing until a commit is fully stored.
  With Restate, each `state().set` is visible to shared handlers as the run
  progresses. To keep Pi's all-or-nothing reads, apply a group of writes with
  no `yield` in between, bump a `seq` watermark last, and have readers trust
  only entries at or below `seq`.
- **Documents** live in the conversation object's state. Watches use
  notification watermarks and awakeable long-polls, as in
  `agent/notifications.ts`. Rewindable `asOf` documents need a document
  version per entry. That is the most expensive part to port.
- **Forks**: a fork is a new object with a parent pointer and a fork entry.
  Reading parent history across objects puts RPC payloads in the journal.
  Copy-on-fork or a summary snapshot keeps journals small.
- **Streaming**: model partials and tool output progress go over a
  non-durable side channel. Only final values are journaled. If a model
  request fails, the run can return `{partial, error}` as a value to keep
  Pi's "aborted partial" entry. After a crash, the partial is lost.
- **Execution environment**: Pi's Node environment is the local disk of the
  harness process, and a Restate retry can run on a different machine. Tools
  need a sandbox with a stable ID, as in `sandbox/turn.ts`.

## Policy choices

1. **When steering takes effect.** Pi places a steer only at the next
   `postTools` boundary and never abandons an in-flight model request. The
   reference agent drops a model round when steering arrives during it and
   asks again. Pi's rule is simpler and loses no work. The reference agent's
   rule reacts sooner.
2. **Interrupt: signal or cancellation.** A signal lets the run finish
   gracefully: it can write aborted results, settle the run as unanswered and
   optionally make a tool-free final call. Cancellation is the backstop.
3. **Bounding a run.** Pi's `onYield` continuations and handoffs can extend a
   run without limit. A journal grows with every step and stays pinned to its
   deployment. A step bound plus `handOver` keeps both bounded: the run
   reports "continued", and the controller starts a fresh invocation with the
   same run ID.

## Costs and concerns

- **This is a fork of Pi's engine semantics, not a host for Pi.** Built-in
  tasks, inbox boundaries and abort behavior are reimplemented. Upstream Pi
  changes would not flow in automatically, and the two could drift.
- **The extension API is not source-compatible.** Async hooks and harness
  tools must become generators. Custom `defineTask` state machines have to be
  rewritten as generator functions. They cannot run as they are.
- **Pi's core helpers are internal.** Boundary placement, `endRun`,
  `startRun` and `appendToolResult` are not in pi-durable's export map, so
  reusing them means vendoring code.
- **Atomic visibility is emulated** with a watermark instead of being
  guaranteed by a storage commit.
- **Streaming partials are not durable.** Pi Durable stores them.
- **Long runs are pinned** to old deployments until they drain or hand over.
- **The design depends on the restatedev/agent architecture.** In effect it
  is that runtime with Pi's extension model and inbox semantics added.

## Alternatives considered

1. **Restate as Pi's `Storage` backend only.** Pi's engine runs unchanged.
   Simple, but it leaves two durability layers and keeps Pi's host
   obligations, such as an in-process scheduler and in-process timers.
2. **An entity object as Pi's Session line, plus a commit registry.** One
   Virtual Object per entity runs Pi's own `createSession` over a
   Restate-backed `Storage`. Commits are named, registered functions called
   with JSON arguments. Tasks run as separate gen-SDK invocations, and each
   commit is an exclusive call to the entity. This keeps Pi's transaction
   semantics and can reuse Pi's storage conformance suite
   (`createStorageConformance`). It costs one entity round trip per commit,
   about 8 per tool-using turn.
3. **One invocation per Pi turn**, with the controller chaining turns at
   boundaries. This matches Pi's boundary rules exactly and keeps invocations
   short. It gives up in-invocation concurrency across turns, for example
   background compaction overlapping several turns.

## Open questions

- Do we accept forking Pi's engine semantics, or do we need upstream Pi
  extensions to run without changes?
- Which steering policy should apply: Pi's boundary-only rule or the
  reference agent's eager one?
- Is a non-durable side channel acceptable for partials and tool progress?
- Should `asOf` documents and in-place forks be supported, or should forks
  copy their parent?
- How should a run that is killed rather than cancelled be detected and
  retired by the controller?

## Sources

- pi-durable 1.0.0 npm package: README, `dist/harness/{harness,scheduler,generation,tool,compaction}.js`,
  `dist/session/session.js`, `dist/types.d.ts`.
- Earendil posts: [Pi 1.0](https://earendil.com/posts/pi-1-0/),
  [Pi Durable](https://earendil.com/posts/pi-durable/).
- Not yet read: Pi's normative spec, `packages/durable/docs/spec.md` in
  `earendil-works/pi`.
- This repository: [architecture](architecture.md),
  [turn runtime](turn-runtime.md), `packages/libs/core/src/agent/active-turn.ts`,
  `packages/libs/core/src/session/service.ts`, and the `restate-gen-sdk`
  skill under `plugins/restate-agent/skills`.
