// The Pi harness for one pump attempt, held in process memory like the
// generator in a durable async generator. It is never rebuilt by replay:
// replay rebuilds only its storage, and the first live step opens a fresh
// harness over it, which is Pi's own crash recovery.

import {BACKGROUND_CONTEXT} from "@earendil-works/chord/context";
import {
  type AgentChange,
  Harness,
  type HarnessOptions,
} from "@earendil-works/pi-durable";

import type {JournaledCommit, JournalStorage} from "./journal-storage.js";

/** A host request for the entity's root conversation. */
export type PiControl = {
  /** Client-chosen key; Pi deduplicates submissions by it. */
  requestId: string;
  text: string;
  whenBusy?: "steer" | "followUp";
};

/** What one journaled pump step observed. */
export type PiStep =
  | ({kind: "commit"} & JournaledCommit)
  | {kind: "idle"}
  | {kind: "none"};

export type PiProcessOptions = Pick<
  HarnessOptions,
  "models" | "registry" | "settings" | "env"
> & {
  /** Agent the root conversation is created with. */
  agent: AgentChange;
  onReport?: (error: unknown) => void;
};

const context = BACKGROUND_CONTEXT;
const IDLE_RECHECK_MS = 20;
const CLOSE_TIMEOUT_MS = 5_000;

export class PiProcess {
  readonly #storage: JournalStorage;
  readonly #options: PiProcessOptions;
  /** Every control this attempt received, in order, replayed ones included. */
  readonly #controls: PiControl[] = [];
  #harness: Promise<Harness> | undefined;
  #failure: unknown;
  #delivering = 0;
  #idleProbe: Promise<boolean> | undefined;

  constructor(storage: JournalStorage, options: PiProcessOptions) {
    this.#storage = storage;
    this.#options = options;
  }

  /**
   * Hands a control to Pi. Called from journal-level code, so it also runs on
   * replay; until the harness opens it is only buffered, and the open delivers
   * every buffered control. Re-delivery is safe because Pi deduplicates the
   * request ID.
   */
  receive(control: PiControl): void {
    this.#controls.push(control);
    if (this.#harness) void this.#deliver(this.#harness, control);
  }

  /**
   * One journaled step: the next Pi commit, or `idle` when Pi has no work, or
   * `none` after `sliceMs` without either.
   */
  async step(signal: AbortSignal, sliceMs: number): Promise<PiStep> {
    if (this.#failure !== undefined) {
      // Pi poisons its session on an ambiguous failure. Throwing lets the run
      // retry; the retry opens a new harness over the same applied state.
      const failure = this.#failure;
      await this.close();
      throw failure;
    }
    // Not awaited: opening writes a recovery commit, and that commit has to
    // leave through this very step.
    const harness = this.#open();
    const stop = new AbortController();
    const ended = Promise.race([
      delay(sliceMs, stop.signal).then(() => "slice" as const),
      aborted(signal),
    ]);
    ended.catch(() => {});
    try {
      while (true) {
        signal.throwIfAborted();
        if (this.#failure !== undefined)
          return await this.step(signal, sliceMs);
        const commit = this.#storage.take();
        if (commit) return {kind: "commit", ...commit};
        const event = await Promise.race([
          this.#storage.arrival().then(() => "commit" as const),
          this.#probeIdle(harness).then((idle) => (idle ? "idle" : "busy")),
          ended,
        ]);
        if (event === "slice") return {kind: "none"};
        if (event === "idle" && this.#storage.quiet) return {kind: "idle"};
        if (event === "busy") await delay(IDLE_RECHECK_MS, stop.signal);
      }
    } finally {
      stop.abort();
    }
  }

  /** Closes the harness. Commits still waiting are abandoned, as in a crash. */
  async close(): Promise<void> {
    const harness = this.#harness;
    this.#harness = undefined;
    this.#failure = undefined;
    this.#idleProbe = undefined;
    this.#storage.abandon(new Error("Pi harness closed"));
    if (!harness) return;
    try {
      const open = await harness;
      await Promise.race([open.close(context), delay(CLOSE_TIMEOUT_MS)]);
    } catch {
      // A harness that failed to open has nothing to close.
    }
  }

  #open(): Promise<Harness> {
    this.#harness ??= (async () => {
      const {agent, onReport, ...options} = this.#options;
      const harness = await Harness.open(
        this.#storage,
        {...options, onReport: onReport ?? (() => {})},
        context,
      );
      await harness.root(context, {agent});
      harness.resume();
      return harness;
    })();
    const harness = this.#harness;
    harness.then(
      () => {
        for (const control of this.#controls)
          void this.#deliver(harness, control);
      },
      (error: unknown) => this.#fail(error),
    );
    return harness;
  }

  async #deliver(harness: Promise<Harness>, control: PiControl): Promise<void> {
    this.#delivering++;
    try {
      const root = await (await harness).root(context);
      await root.submit(
        {
          type: "input",
          content: control.text,
          requestId: control.requestId,
          ...(control.whenBusy ? {whenBusy: control.whenBusy} : {}),
        },
        context,
      );
    } catch (error) {
      if (harness === this.#harness) this.#fail(error);
    } finally {
      this.#delivering--;
    }
  }

  /**
   * Whether Pi has nothing left to do. Single-flight: Pi reads queue behind
   * a pending commit, so a probe may wait until the pump journals it.
   */
  #probeIdle(harness: Promise<Harness>): Promise<boolean> {
    this.#idleProbe ??= (async () => {
      try {
        const open = await harness;
        await open.waitForIdle(context);
        const inspection = await open.inspect(context);
        return (
          this.#delivering === 0 &&
          inspection.tasks.length === 0 &&
          inspection.submissions.length === 0
        );
      } catch {
        return false;
      } finally {
        this.#idleProbe = undefined;
      }
    })();
    return this.#idleProbe;
  }

  #fail(error: unknown): void {
    this.#failure ??= error;
    this.#storage.abandon(error);
  }
}

/** Resolves after `ms`, or early and quietly when `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      {once: true},
    );
  });
}

/** Rejects when `signal` aborts; never settles otherwise. */
function aborted(signal: AbortSignal): Promise<never> {
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
  promise.catch(() => {});
  return promise;
}
