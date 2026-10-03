# @restate-agents/pi

Prototype: [Pi Durable](https://earendil.com/posts/pi-durable/)
(`@earendil-works/pi-durable` 1.0.1) embedded unchanged in Restate, with the
Restate journal as Pi's commit log.

Pi's own JSONL backend is a `MemoryStorage` plus an append-only file. It
validates a commit with `prepareCommit`, appends it, applies it, and recovers by
replaying the file. `JournalStorage` does the same, but the "append" is a
`restate.run` whose result is the commit's writes.

## Shape

| Piece | Lifetime | Holds |
| --- | --- | --- |
| `Pi/<entity>` controller | Short exclusive calls | Pending controls, the running pump's ID |
| `PiPump/<entity>.pump` | One invocation per busy period | A `PiProcess`: the Pi `Harness` in process memory |
| Journal of that invocation | While the pump runs | One `run` per Pi commit, plus control signals |
| Object state `pi.log.*` | Across pumps | The same commits, written when the pump ends (and every 256 commits) |

The pump loop:

1. Load the log from state and apply it to `JournalStorage`.
2. Loop over `select({step, inbox})`:
   - `step` is a `run` that returns the next Pi commit, `idle`, or `none`
     after a slice with neither;
   - a commit is applied from journal-level code, which also resolves the Pi
     `commit()` call waiting on it;
   - an inbox signal is handed to Pi (`submit` with the control's
     `requestId`).
3. On `idle`: close the harness, flush the log, and report to the controller
   which controls it received.

On replay, journaled steps only rebuild the storage, and Pi does not run. The
first live step opens a new harness over the rebuilt storage, which is Pi's
own crash recovery. Replayed controls are delivered again after the open, and
Pi deduplicates them by `requestId`.

Fencing comes from Restate: an attempt Restate has given up on cannot add
journal entries, so its harness blocks on its next commit.

## Test

`test/e2e.test.ts` needs a disposable Restate server (admin `:9070`,
ingress `:8080`, or `RESTATE_ADMIN_URL` / `RESTATE_INGRESS_URL`) and is
skipped without one. It runs `test/service.ts`, which uses a faux model and a
tool that kills the process the first time it runs. The test restarts the
process each time it exits.

```bash
NO_PROXY=127.0.0.1 node --import tsx --test test/e2e.test.ts
```

It covers:

- two runs in two pumps, the second rebuilt from state;
- a duplicate `requestId` answered once;
- controls sent while a pump runs, delivered as signals;
- a crash inside an unsafe tool. Pi reports the tool as interrupted and
  continues the run, after Restate retries the pump and its journal rebuilds
  the store.

## Not done yet

- **Only some controls.** Only input to the root conversation. Abort,
  configure, compaction and other conversations are missing.
- **Sleeps keep the pump alive.** A retry backoff or deferred poll is a live
  task, so the pump stays resident through it. The plan is a wrapped
  `runtime.sleep` and a delayed wake.
- **The log only grows.** Every pump start loads and replays it, and `entries`
  rebuilds the whole store per read. It needs compaction or snapshots.
- **Readers lag.** They see the log as of the last flush.
- **Some failures leave state stuck.** If a pump is killed, `pumpEnded` is
  never sent and the controller keeps a stale pump ID.
- **Abandoned attempts are not stopped.** The gen SDK does not expose an
  attempt-ended signal. Such an attempt's harness is left blocked on a commit
  that never resolves.
