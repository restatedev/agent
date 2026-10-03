# Pi Durable on Restate: Pi embedded, Restate as the host

Status: exploratory design note. Not a decision. It is the counterpart to
[`pi-durable-on-restate.md`](./pi-durable-on-restate.md), which replaces
Pi's engine. This note goes the other way: it keeps as much of Pi as possible,
unchanged and in-process, and uses Restate only for what Pi asks of its host.

## Goal

Run `@earendil-works/pi-durable` 1.0.0 as published:

- its `Harness`, `Session`, `TaskScheduler` and built-in tasks;
- its extension, tool and hook API, source compatible;
- its own recovery semantics: checkpoints in `Storage`, phases re-run after a
  crash, and `replay: "safe" | "unsafe"` tools.

Restate takes over the five host obligations that Pi lists but does not
enforce (see "Host obligations Pi does not enforce" in the sibling note):

| Pi host obligation | Provided by |
| --- | --- |
| Exactly one process owns a storage | One controller per entity starts at most one pump, the pump is an exclusive handler, and storage-level fencing stops zombie attempts |
| Supervision: restart a dead harness | Restate retries the pump invocation, and `Harness.open` recovers |
| A live process for timers | Pump returns when Pi is only sleeping; a delayed Restate send wakes it |
| Reinstall the same code before `resume()` | The service deployment carries the registry; rotation moves a harness to new code |
| Durability of the backend | Pi's own backend, external to Restate (see Storage) |

## Principle: two layers that never overlap

The two durability layers own disjoint things:

- **Pi's `Storage`** holds all agent state: conversations, entries, tasks,
  submissions, documents and streamed partials. Pi writes it whenever it
  wants, from its own commits. Restate never sees these writes.
- **The Restate journal** holds only host facts: which controls were
  delivered to the harness, which pump is current, and when to wake up. It
  never records a model call, a tool call or a Pi commit.

Replay of the Restate journal therefore never has to reproduce Pi's
behavior. A replayed pump skips the deliveries it already made, and its
harness is reopened from storage, which is exactly Pi's own recovery path.
The bridge between the two layers is Pi's `requestId`: re-delivering a
submission after a crash is deduplicated by Pi.

## Shape

```text
client ──► PiEntity/<entity>          Virtual Object, gen SDK, controller
             │  state: pending controls, current pump, wake token
             │  sends ─► PiHost/<entity>.pump    exclusive, gen SDK
             │  signals ─► pump invocation ("pi.inbox")
             ▼
           PiHost/<entity>.pump ─── one attempt = one process-local Harness
             │  journal: drive slices, control deliveries, end report
             ▼
           Harness ── Session ── Storage (Pi backend, one database per entity)
             │
             └─► side channel: watchEvents / partials to clients
```

- **Isolation.** The key is the entity, for example a user. One entity is
  one Pi storage and one Harness. That matches Pi's "one storage is one
  harness" rule. An entity can hold many conversations, since Pi supports
  the root conversation and created child conversations in one storage.
- **`PiEntity`** follows `Agent` in this repository. Its handlers are
  short and exclusive. It never touches the harness.
- **`PiHost.pump`** follows `AgentSession.doTurn`. It runs while Pi has work
  and loops inside. Unlike `doTurn`, the loop body is Pi's scheduler, not
  ours.

## Storage

Pi needs a `Storage` that every pump attempt can reach, wherever Restate
schedules it. Pi's built-in memory, local SQLite and JSONL backends are
process- or disk-local, so they do not fit stateless handlers as they are.

| Option | Work | Notes |
| --- | --- | --- |
| **Pi's portable SQLite core over a networked SQLite (for example libSQL), one database per entity** | Implement the `SqliteDatabase` facade: `exec`, `run`, `get`, `all`, `transaction`, `close` | Reuses Pi's schema, migrations and commit logic. The facade is where fencing goes. Recommended starting point |
| A Postgres `Storage` implementing Pi's interface | Write the whole interface: commit, scans, documents, submissions | Validate it with Pi's exported `createStorageConformance`. More work, more familiar operations |
| A Restate-backed `Storage`: a `PiStore/<entity>` object with an exclusive `commit` and shared reads, called through ingress from inside runs | Write the interface over K/V, including scan indexes | Keeps everything in Restate. Each commit is an invocation, and partials commit up to 10 times a second per streaming conversation |

The rest of the note assumes the first option.

### Fencing

Restate runs at most one invocation of an exclusive handler per key. A
retried attempt can still overlap a previous attempt that Restate gave up on
but whose process is still running, for example across a network partition.
Pi has no locking, so the storage must reject the older attempt:

1. When a pump attempt opens the harness, the facade first takes over the
   database: `UPDATE owner SET epoch = epoch + 1 RETURNING epoch`.
2. Every `transaction` the facade runs first checks that `owner.epoch` still
   equals its own epoch, and throws if it does not.
3. The `run` closure's `AbortSignal` closes the harness, so a cancelled
   attempt also stops on its own when it can.

The newest attempt always wins. The older attempt cannot commit. Depending on
how Pi's SQLite core classifies the failure, the older attempt either
discards the transaction (`StorageRejected`) or poisons its session. Both are
fine for a process that should stop.

## The pump

Sketch in the gen SDK. `PiHostProcess` is process-local and holds the
`Harness` for this attempt. It opens the harness lazily, on the first run
that needs it, so a replay that only skips journaled entries opens nothing.

```ts
const piHost = restate.object({
  name: "PiHost",
  handlers: {
    *pump(start: PumpStart): restate.Operation<PumpEnd> {
      const entity = restate.handlerRequest().key!;
      const host = PiHostProcess.forAttempt(entity, start);
      const inbox = controlInbox(); // drains "pi.inbox" signals, like createSteeringInbox
      const delivered: string[] = [];

      while (true) {
        // A bounded slice of Pi's own scheduling, so journal activity stays regular.
        const slice = restate.spawn(
          restate.run((signal) => host.drive(signal, SLICE), {name: "drive", retry: driveRetry}),
        );
        let status: DriveStatus | undefined;
        while (status === undefined) {
          const {tag, future} = yield* restate.select({slice, control: inbox.ready});
          if (tag === "slice") {
            status = yield* future;
            continue;
          }
          for (const control of inbox.drain()) {
            yield* restate.run((signal) => host.apply(control, signal), {name: `apply ${control.requestId}`});
            delivered.push(control.requestId);
          }
        }
        if (status.kind === "busy") continue; // Pi is still working: next slice, same harness
        yield* restate.run(() => host.close(), {name: "close"});
        const end = {...status, delivered};
        restate.sendClient(piEntity, entity).pumpEnded(end);
        return end;
      }
    },
  },
});
```

`host.drive(signal, slice)` does the following:

1. It opens the harness if this attempt has not already opened it: fence,
   `Harness.open(storage, options, context)`, then `resume()`. The context
   is cancelled by `signal`.
2. It waits up to `slice` for Pi to reach a quiet point, and returns one of:
   - `busy`: the slice ended with work in flight. The harness stays open,
     and the next slice continues it. Nothing is re-run.
   - `idle`: no live tasks. This uses `waitForIdle()` and then `inspect()`,
     because `waitForIdle` ignores background tasks.
   - `sleeping(until)`: every running task is inside `runtime.sleep`. See
     "Timers".
   - `blocked`: live tasks are `blocked` because their definition is missing
     or too old. Only new code can move them.
   - `rotate`: the controller asked for rotation and Pi reached a quiet
     point.

The harness lives across slices in the same process. Slices exist only to
keep each `run` short, so a pump that runs for hours does not depend on long
`run` closures staying within Restate's inactivity and abort timeouts.

`host.apply(control)` calls the matching Pi API on the live harness:

| Control | Pi call | Idempotent on re-delivery because |
| --- | --- | --- |
| `submit` (prompt, steer, follow-up, write) | `conversation.submit(input, {requestId, mode})` | Pi deduplicates `requestId` per conversation |
| `abort` | `abortSubmission(id)` or `abortTask(id)` | Returns `already_placed`, `settled` or `terminal` the second time |
| `configure` | `conversation.configure(change)` | Applying the same change twice ends in the same state, if changes are absolute |
| `compact` | `conversation.compact()` | Not deduplicated. A second compaction is wasted work, not wrong. Open question |
| `createConversation` | `harness.createConversation(options)` | Needs a host-chosen ID or a lookup first. Open question |
| `rotate` | sets a flag that `drive` checks | A flag |

## Controller

`PiEntity/<entity>` keeps a small state machine, the same way `Agent` and
`active-turn.ts` do here:

- `pending`: controls accepted but not yet reported as delivered, in order.
- `pump`: the current pump's invocation ID, or nothing.
- `wake`: a token for the scheduled wake-up, so stale wakes are ignored.

Handlers:

- **`submit`, `abort`, `configure`, `compact`**: append to `pending`. If a pump
  is running, resolve its `pi.inbox` signal. Otherwise start one with
  `sendClient(piHost, entity).pump(...)` and store its ID. Clients use an
  ingress idempotency key. The `requestId` goes all the way through to Pi.
- **`pumpEnded(end)`**: drop `end.delivered` from `pending`, then decide:
  - anything left in `pending` (sent after the pump stopped reading
    signals) starts a new pump, which receives it as its first control;
  - `sleeping(until)` schedules `wake` with a delayed send and stores the
    token;
  - `blocked` records the state for operators, and the next deploy or
    `rotate` restarts the pump;
  - `idle` clears `pump`.
- **`wake(token)`**: if the token is current and no pump is running, start
  one.
- **`rotate`**: signal the running pump to stop at its next quiet point. A
  forced rotation (cancel the pump) is also correct, because a close is a
  crash to Pi.

`PiHost` being a Virtual Object keyed by the entity is a second guarantee: a
second pump queues behind the first instead of running beside it.

## Timers

Pi sleeps inside a running phase: `runtime.sleep(until)` awaits an
in-process `setTimeout` against an absolute deadline. Retry backoff and
deferred polls use it. Keeping a process alive through long sleeps is the
obligation to remove.

The host can see sleeps without changing Pi. The registry is host code, and
the built-in task definitions are exported (`GenerationTask`, `ToolTask`,
`CompactionTask`). The host registers wrapped definitions under the same
names, and the wrapper intercepts the phase handlers' `runtime.sleep` to
record the deadline in a process-local set. When `inspect()` shows that
every running task is in that set, `drive` returns `sleeping(min until)`.

The pump then closes the harness and returns, and the controller schedules
a delayed `wake`. To Pi, the close is a crash. On reopen the sleeping task's
phase re-runs from its last checkpoint, reaches the same `sleep(until)`
with the same absolute deadline, and returns at once if the deadline has
passed. Phases must already be safe to repeat up to their next commit, so
this is within Pi's contract. The cost is redoing the phase's work before
its sleep.

Fallback, if wrapping proves impractical: keep the pump alive through sleeps
shorter than a threshold, and accept a resident process for longer ones.

## Deployments and rotation

A Restate invocation is pinned to the deployment it started on. Here that
pins only the pump. All of Pi's state is in its storage, and a close is
safe, so a pump can be moved to new code at any time:

1. Deploy the new version. It carries the new registry.
2. Call `rotate` on each active entity, or let pumps rotate when they next go
   idle or sleep.
3. The new pump opens the harness with the new registry. Pi's `version` and
   `migrate` take over from there. A task with no matching definition stays
   `blocked` until code that can run it is deployed.

A rotation in the middle of a phase costs what a crash costs: a model request
is resubmitted, and an unsafe tool in flight becomes "interrupted". The
default is to rotate at a quiet point. Forced rotation is for code that has
to go.

## Reads and streaming

Pi commits streamed partials to its storage (`LiveDoc`, at most every
100 ms), so partials are durable here. In the sibling note they are not.
Getting them out of the process is still a host job:

- **Live**: the pump subscribes to `watchEvents` and forwards events to a
  side channel, as in the sibling note.
- **At rest**: a second process must not `Harness.open` the storage, since
  opening writes a recovery commit. Options:
  1. read the database directly with a read-only `Storage` instance and
     derive the view, if Pi's view code works without a Session (open
     question);
  2. have the pump write a projection, for example the last transcript page
     and status, to `PiEntity` state at each quiet point;
  3. when a pump is running, ask it with a control that carries an
     awakeable to reply on.

## Failures

| Failure | What happens |
| --- | --- |
| Pump process crashes mid-run | Restate retries the pump. Replay skips journaled deliveries and finished slices. The next `drive` opens the harness, and Pi recovers: running tasks become pending, the model request is resubmitted, unsafe tools in flight are reported interrupted |
| An older attempt is still running | Fenced. Its commits fail, and its `AbortSignal` closes its harness |
| Delivery `run` re-executes after a crash | Pi deduplicates by `requestId` |
| Control arrives after the pump stopped reading | Still in `pending`. `pumpEnded` starts the next pump with it |
| Storage outage or ambiguous commit | Pi poisons the session. `drive` throws, and the run retry reopens the harness. `driveRetry` is unbounded with capped backoff, so an outage does not pause the invocation after the default 70 attempts |
| Duplicate client request | Ingress idempotency key, then Pi's `requestId` |
| Missing or old task definition | Pi marks the task `blocked`. The pump reports it, and a deploy and rotation fix it |
| Long sleep | The pump returns, and a delayed `wake` restarts it |

## Compared with one run per invocation

| | One run per invocation (sibling note) | Pi embedded (this note) |
| --- | --- | --- |
| Pi code | Engine replaced; surface re-implemented | Unchanged package |
| Extension API | Hooks and tools rewritten as generators | Pi's own, source compatible |
| Upstream Pi releases | Ported by hand | Version bump |
| Durability layers | One: the Restate journal and state | Two, with disjoint ownership |
| Agent state lives in | Restate object state | An external database per entity |
| Finished model call, then crash | Replayed from the journal | Pi re-runs the phase from its last checkpoint |
| Streamed partials | Side channel only, not durable | Durable in Pi's `LiveDoc`, plus a side channel |
| Timers | `restate.sleep` | Wrapped `runtime.sleep` and a delayed `wake` |
| Visibility in Restate's UI | One journal entry per model call and tool | Deliveries and drive slices only |
| Moving a long run to new code | Pinned until the run ends | Rotate at any quiet point |
| Restate features used | Journal, state, signals, spawn, select | Exclusive objects, signals, retries, delayed sends, idempotency |

## Costs and concerns

- **A second database.** Each entity's agent state lives outside Restate.
  That is new infrastructure to operate, back up and secure, and Restate is
  no longer the single source of truth.
- **Restate sees little.** The journal shows deliveries and slices, not model
  calls or tools. Debugging uses Pi's task graph and reports instead.
- **Pi's recovery costs, not Restate's.** A crash after a model response
  finished but before Pi committed it pays for the request again.
- **A resident process per active entity.** The same as the sibling note,
  except that long sleeps release it.
- **Long-lived pumps.** They need long-running containers, not request-time-
  limited platforms such as Lambda.
- **Wrapping built-in tasks.** It depends only on the public `TaskRuntime`
  interface, but on how definitions are registered, which is not yet
  verified.
- **Rotation is a crash.** It is cheap at quiet points and costly mid-phase.

## Open questions

1. Does the portable SQLite core write anything outside `transaction`, for
   example in `mintId` or migrations? Fencing has to cover every write.
2. How does `SqliteStorage` classify a facade rejection: `StorageRejected`
   or poison?
3. Can a read-only process derive `ConversationView` and `ContextView` from a
   `Storage` without opening a Session?
4. Can the built-in definitions be wrapped and registered under their own
   names, with the registry still accepting them as the built-ins?
5. Can `compact` and `createConversation` be made idempotent on
   re-delivery, for example with host-chosen IDs?
6. What slice length keeps journal activity comfortably within Restate's
   inactivity and abort timeouts, and is a configured per-service timeout
   better than slicing?
7. Pi's normative spec (`docs/spec.md` in the Pi repository) has not been
   read. It may constrain hosting further, in particular around close and
   reopen.

## Sources

- `@earendil-works/pi-durable` 1.0.0, `dist/`:
  - `types.d.ts`: `Storage`, `TaskRuntime.sleep`
  - `harness/types.d.ts`: `Harness`, `HarnessInspection`, hooks
  - `harness/scheduler.js`: `#sleep`, the timer loop
  - `storage/sqlite/database.d.ts`: `SqliteDatabase` facade
  - `index.d.ts`: exports, including the built-in task definitions
  - README
- This repository:
  - `packages/libs/core/src/agent/active-turn.ts`: controller-side signals
    and end-of-turn reconciliation
  - `packages/libs/core/src/session/steering.ts`: signal inbox pattern
  - `plugins/restate-agent/skills/restate-gen-sdk/`: gen-SDK reference
