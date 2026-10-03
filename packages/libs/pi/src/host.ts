// Restate host for an embedded Pi Durable harness, one per entity key.
//
// - `<name>`: the controller. Short exclusive handlers; it never touches Pi.
//   It starts a pump when work arrives and none is running, forwards controls
//   to a running pump as signals, and reconciles controls a pump never read.
// - `<name>Pump`: one invocation per busy period. The journal is Pi's commit
//   log while it runs; object state carries the log to the next pump.

import {BACKGROUND_CONTEXT} from "@earendil-works/chord/context";
import {MemoryStorage} from "@earendil-works/pi-durable";
import type {EntryRecord} from "@earendil-works/pi-durable";
import {ROOT_CONVERSATION_ID} from "@earendil-works/pi-durable";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

import {type JournaledCommit, JournalStorage} from "./journal-storage.js";
import {
  type PiControl,
  PiProcess,
  type PiProcessOptions,
} from "./pi-process.js";

export type PiHostOptions = PiProcessOptions & {
  /** Controller object name; the pump object is `${name}Pump`. */
  name: string;
  /** Longest a journaled Pi step waits before recording a `none` step. */
  sliceMs?: number;
};

type PumpInput = {controls: PiControl[]};
type PumpEnd = {pumpId: string; delivered: string[]};

const INBOX = "pi.inbox";
const LOG_CHUNKS = "pi.log.chunks";
const CHUNK = 64;
/** Commits a pump keeps only in its journal before writing them to state. */
const FLUSH_EVERY = 256;

export function createPiHost(options: PiHostOptions) {
  const {name, sliceMs = 10_000, ...processOptions} = options;
  const controllerName = name;
  const pumpName = `${name}Pump`;

  const pump = restate.object({
    name: pumpName,
    handlers: {
      /** Runs Pi until it is idle. Started only by the controller. */
      *pump(input: PumpInput): restate.Operation<void> {
        const log = yield* readLog(restate.state());
        const storage = new JournalStorage();
        for (const chunk of log.chunks)
          for (const commit of chunk) storage.applyJournaled(commit);

        const pi = new PiProcess(storage, processOptions);
        const delivered: string[] = [];
        const receive = (control: PiControl) => {
          pi.receive(control);
          delivered.push(control.requestId);
        };
        input.controls.forEach(receive);

        const nextStep = () =>
          restate.run(({signal}) => pi.step(signal, sliceMs), {name: "pi"});
        let step = nextStep();
        let inbox = restate.signal<PiControl>(INBOX);
        let unflushed = 0;
        while (true) {
          const next = yield* restate.select({step, inbox});
          if (next.tag === "inbox") {
            receive(yield* next.future);
            inbox = restate.signal<PiControl>(INBOX);
            continue;
          }
          const result = yield* next.future;
          if (result.kind === "idle") break;
          if (result.kind === "commit") {
            const commit = {seq: result.seq, writes: result.writes};
            storage.applyJournaled(commit);
            log.append(commit);
            if (++unflushed >= FLUSH_EVERY) {
              log.flush(restate.state());
              unflushed = 0;
            }
          }
          step = nextStep();
        }

        yield* restate.run(() => pi.close(), {name: "close"});
        log.flush(restate.state());
        const end: PumpEnd = {pumpId: restate.handlerRequest().id, delivered};
        yield* restate.sendClient(controller, key()).pumpEnded(end);
      },

      /** The root conversation's entries, oldest first, rebuilt from the log. */
      *entries(): restate.Operation<EntryRecord[]> {
        const log = yield* readLog(restate.sharedState());
        return yield* restate.run(() => rootEntries(log.chunks), {
          name: "rebuild",
        });
      },
    },
    options: {
      handlers: {
        pump: {
          ingressPrivate: true,
          inactivityTimeout: {minutes: 10},
          abortTimeout: {minutes: 15},
        },
        entries: {shared: true},
      },
    },
  });

  const controller = restate.object({
    name: controllerName,
    handlers: {
      /** Accepts one control for the entity's root conversation. */
      *submit(control: PiControl): restate.Operation<void> {
        const state = restate.state();
        const pending = (yield* state.get<PiControl[]>("pending")) ?? [];
        if (pending.some((c) => c.requestId === control.requestId)) return;
        state.set("pending", [...pending, control]);
        const running = yield* state.get<string>("pump");
        if (running) {
          restate.invocation(running).signal<PiControl>(INBOX).resolve(control);
          return;
        }
        yield* startPump([...pending, control]);
      },

      /** A pump finished; restart for controls it never read. */
      *pumpEnded(end: PumpEnd): restate.Operation<void> {
        const state = restate.state();
        if ((yield* state.get<string>("pump")) !== end.pumpId) return;
        state.clear("pump");
        const delivered = new Set(end.delivered);
        const pending = (
          (yield* state.get<PiControl[]>("pending")) ?? []
        ).filter((control) => !delivered.has(control.requestId));
        if (pending.length === 0) {
          state.clear("pending");
          return;
        }
        state.set("pending", pending);
        yield* startPump(pending);
      },

      /** The running pump's invocation ID, if any. */
      *status(): restate.Operation<{pump: string | null; pending: number}> {
        const state = restate.sharedState();
        return {
          pump: yield* state.get<string>("pump"),
          pending: ((yield* state.get<PiControl[]>("pending")) ?? []).length,
        };
      },
    },
    options: {handlers: {status: {shared: true}}},
  });

  function* startPump(controls: PiControl[]): restate.Operation<void> {
    const started = yield* restate.sendClient(pump, key()).pump({controls});
    restate.state().set("pump", started.id);
  }

  return {controller, pump};
}

function key(): string {
  const value = restate.handlerRequest().key;
  if (!value) throw new TerminalError("Pi host handlers require a key");
  return value;
}

/** The commit log in chunked object state, plus commits not yet written. */
function* readLog(state: restate.SharedState) {
  const count = (yield* state.get<number>(LOG_CHUNKS)) ?? 0;
  const chunks: JournaledCommit[][] = [];
  for (let i = 0; i < count; i++)
    chunks.push((yield* state.get<JournaledCommit[]>(chunkKey(i))) ?? []);
  const dirty = new Set<number>();
  return {
    chunks,
    append(commit: JournaledCommit) {
      let last = chunks.length - 1;
      if (last < 0 || chunks[last]!.length >= CHUNK) {
        chunks.push([]);
        last++;
      }
      chunks[last]!.push(commit);
      dirty.add(last);
    },
    flush(state: restate.State) {
      for (const i of dirty) state.set(chunkKey(i), chunks[i]);
      if (dirty.size > 0) state.set(LOG_CHUNKS, chunks.length);
      dirty.clear();
    },
  };
}

function chunkKey(index: number): string {
  return `pi.log.${index}`;
}

async function rootEntries(
  chunks: JournaledCommit[][],
): Promise<EntryRecord[]> {
  const storage = new MemoryStorage();
  for (const chunk of chunks)
    for (const commit of chunk)
      storage.prepareCommit(commit.writes, commit.seq as never).apply();
  const entries: EntryRecord[] = [];
  if (!(await storage.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)))
    return entries;
  let cursor;
  do {
    const page = await storage.scanEntries(
      {conversationId: ROOT_CONVERSATION_ID},
      100,
      cursor,
      BACKGROUND_CONTEXT,
    );
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries.reverse();
}
