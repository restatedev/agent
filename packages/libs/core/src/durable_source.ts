import {TerminalError} from "@restatedev/restate-sdk";
import {
  type Future,
  type Operation,
  type RunActionOpts,
  run,
} from "@restatedev/restate-sdk-gen";

// The result of pulling once from a durable source:
//   next    -> here's the next value
//   done    -> the underlying stream ended normally
//   aborted -> we're replaying past the point the live stream existed; the
//              source can no longer produce fresh values.
export type Next<T> =
  | {type: "next"; value: T}
  | {type: "done"}
  | {type: "aborted"};

export type DurableSource<T> = {
  next(): Future<Next<T>>;
};

// Wrap a non-resumable source (e.g. an LLM completion, or any non-deterministic
// stream that can't be re-run to produce the same output) as a durable source.
// Each value pulled is journaled via `run`, so on replay the recorded prefix is
// returned without touching the live source; once we're past it, `next` reports
// `aborted` rather than re-running the source.
//
// The factory receives an AbortSignal OWNED BY THE DURABLE SOURCE — pass it
// into the underlying request (e.g. fetch(url, {signal})). Every pull executes
// via `run`, and `run` hands its action a signal that fires when that step is
// interrupted; the durable source forwards that into the factory's signal, so
// the live request is torn down with the task instead of draining in the
// background. Consumers manage no AbortController of their own. (A streaming
// source spends essentially all its time suspended inside a pull, so an
// interrupt lands there; the one gap is an interrupt arriving when no pull is
// in flight and none follows — then the live source is only reclaimed with the
// process, not aborted.)
export function* durableSource<T>(
  nonResumableSource: (signal: AbortSignal) => AsyncGenerator<T>,
): Operation<DurableSource<T>> {
  // Owns the live source's teardown; aborted when an in-flight pull is
  // interrupted. Like `stream` below it lives only in this process's memory —
  // after a crash/replay there is nothing live left to abort.
  const controller = new AbortController();

  // Lives only in this process's memory — it is NOT restored on replay. After a
  // crash/replay we re-enter with `stream` undefined, which is how we detect
  // that the live source is gone.
  let stream: AsyncGenerator<T> | undefined;

  async function create() {
    try {
      stream = nonResumableSource(controller.signal);
    } catch (error) {
      throw new TerminalError(
        `durableSource: failed to create source: ${error}`,
      );
    }
  }

  async function next({signal}: RunActionOpts): Promise<Next<T>> {
    if (!stream) {
      return {type: "aborted"};
    }
    // Forward an interruption of THIS pull to the live source. Checked first
    // in case the pull started with its signal already aborted.
    if (signal.aborted) {
      controller.abort();
    }
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, {once: true});
    try {
      const n = await stream.next();
      if (n.done) {
        return {type: "done"};
      }
      return {type: "next", value: n.value};
    } catch (error) {
      throw new TerminalError(`durableSource: failed to pull: ${error}`);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  // Journal the act of starting the stream; on replay this is a no-op and
  // `stream` stays undefined. (Async generators are lazy — the factory call
  // does not start the underlying request; the first pull does.)
  yield* run(create);

  return {
    next: () => run(next),
  };
}
