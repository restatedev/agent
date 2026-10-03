// Pi Durable Storage whose commit log is the Restate journal. It follows Pi's
// JSONL backend: MemoryStorage serves reads, a commit is validated with
// prepareCommit, persisted, and only then applied. Here "persisted" means a
// restate.run recorded the commit's writes; the pump applies them afterwards
// from journal-level code, so a replay rebuilds the same store without Pi.

import type {Context} from "@earendil-works/chord";
import {
  MemoryStorage,
  type Seq,
  type StorageWrite,
} from "@earendil-works/pi-durable";

/** One Pi commit as journaled and as kept in object state. */
export type JournaledCommit = {
  seq: number;
  writes: StorageWrite[];
};

type PendingCommit = {
  writes: readonly StorageWrite[];
  resolve(seq: Seq): void;
  reject(error: unknown): void;
};

export class JournalStorage extends MemoryStorage {
  #queue: PendingCommit[] = [];
  #inflight: (PendingCommit & {seq: number}) | undefined;
  #arrival: PromiseWithResolvers<void> = Promise.withResolvers();

  /** Queues the commit; it resolves once the pump has applied it from the journal. */
  override commit(
    writes: readonly StorageWrite[],
    _context: Context,
  ): Promise<Seq> {
    return new Promise<Seq>((resolve, reject) => {
      this.#queue.push({writes, resolve, reject});
      this.#arrival.resolve();
    });
  }

  /** Resolves when a commit is waiting to be taken. */
  arrival(): Promise<void> {
    return this.#queue.length > 0 ? Promise.resolve() : this.#arrival.promise;
  }

  /**
   * Takes the next queued commit and validates it against the applied state
   * without changing it. An invalid commit is rejected here: like a JSONL
   * commit that fails before its append, nothing was persisted.
   */
  take(): JournaledCommit | undefined {
    // The next commit validates against state that includes this one.
    if (this.#inflight) return undefined;
    while (this.#queue.length > 0) {
      const next = this.#queue.shift()!;
      if (this.#queue.length === 0) this.#arrival = Promise.withResolvers();
      try {
        const prepared = this.prepareCommit(next.writes);
        this.#inflight = {...next, seq: prepared.seq};
        return {seq: prepared.seq, writes: [...prepared.writes]};
      } catch (error) {
        next.reject(error);
      }
    }
    return undefined;
  }

  /** Whether no commit is queued or waiting for the journal. */
  get quiet(): boolean {
    return this.#queue.length === 0 && this.#inflight === undefined;
  }

  /**
   * Applies a journaled commit. On replay nothing waits for it; live, it
   * settles the commit Pi is waiting on.
   */
  applyJournaled(commit: JournaledCommit): void {
    const seq = this.prepareCommit(commit.writes, commit.seq as Seq).apply();
    const inflight = this.#inflight;
    if (inflight?.seq === commit.seq) {
      this.#inflight = undefined;
      inflight.resolve(seq);
    }
  }

  /** Rejects every commit still waiting, for example when the harness closes. */
  abandon(error: unknown): void {
    const waiting = [
      ...(this.#inflight ? [this.#inflight] : []),
      ...this.#queue.splice(0),
    ];
    this.#inflight = undefined;
    this.#arrival = Promise.withResolvers();
    for (const pending of waiting) pending.reject(error);
  }
}
