import {TerminalError} from "@restatedev/restate-sdk";
import {type Future, type Operation, run} from "@restatedev/restate-sdk-gen";

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
export function* durableSource<T>(
  nonResumableSource: () => AsyncGenerator<T>,
): Operation<DurableSource<T>> {
  // Lives only in this process's memory — it is NOT restored on replay. After a
  // crash/replay we re-enter with `stream` undefined, which is how we detect
  // that the live source is gone.
  let stream: AsyncGenerator<T> | undefined;

  async function create() {
    try {
      stream = nonResumableSource();
    } catch (error) {
      throw new TerminalError(
        `durableSource: failed to create source: ${error}`,
      );
    }
  }

  async function next(): Promise<Next<T>> {
    if (!stream) {
      return {type: "aborted"};
    }
    try {
      const n = await stream.next();
      if (n.done) {
        return {type: "done"};
      }
      return {type: "next", value: n.value};
    } catch (error) {
      throw new TerminalError(`durableSource: failed to pull: ${error}`);
    }
  }

  // Journal the act of starting the stream; on replay this is a no-op and
  // `stream` stays undefined.
  yield* run(create);

  return {
    next: () => run(next),
  };
}
