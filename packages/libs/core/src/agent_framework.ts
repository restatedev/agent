import type {GenericCall} from "@restatedev/restate-sdk";
import type {Future, Operation} from "@restatedev/restate-sdk-gen";

export type LLMChunk =
  | {type: "text"; content: string}
  | {type: "tool_call"; name: string; args: Record<string, string>};

// The result of pulling once from a durable source:
//   next    -> here's the next value
//   done    -> the underlying stream ended normally
//   aborted -> we're replaying past the point the live stream existed; the
//              source can no longer produce fresh values.
export type Next<T> =
  | {type: "next"; value: T}
  | {type: "done"}
  | {type: "aborted"};

// A source whose values are journaled as they are pulled: on replay after a
// crash the recorded prefix is re-yielded and then `next` reports `aborted`
// (the live source is gone), rather than re-running a non-deterministic stream.
export type DurableSource<T> = {
  next(): Future<Next<T>>;
};

export interface StepContext {
  // Run a closure, recording its value
  run<T>(closure: (abortSignal: AbortSignal) => Promise<T>): Future<T>;

  // Call another agent
  call<REQ, RES>(c: GenericCall<REQ, RES>): Future<RES>;

  // Prompt the LLM, returning a durable stream of chunks
  prompt(prompt: string): Operation<DurableSource<LLMChunk>>;
}
