import {
  allSettled,
  InterruptedError,
  type Operation,
  select,
  spawn,
  type Task,
} from "@restatedev/restate-sdk-gen";
import {
  Guest,
  type GuestLimits,
  type Json,
  type Outcome,
  ProgramError,
  type Request,
} from "./guest.js";

/** The caller supplies already-durable tool operations, never plain host I/O. */
export type ProgramTools = {
  names: string[];
  execute(request: Request): Operation<Outcome>;
};

/** Runs inline in the current Restate scheduler and invocation. */
export function* executeProgram(
  source: string,
  tools: ProgramTools,
  limits: GuestLimits = {},
): Operation<Json> {
  let guest: Guest | undefined;
  const pending = new Map<string, Task<Outcome>>();
  let value: Json = null;
  let failure: {error: unknown} | undefined;
  let stopReason: unknown = new InterruptedError(
    "Program finished; unawaited tool call cancelled",
  );
  try {
    guest = new Guest(source, tools.names, limits);
    while (true) {
      guest.drain();
      for (const request of guest.takeRequests()) {
        pending.set(request.id, spawn(tools.execute(request)));
      }
      const state = guest.state();
      if (state.status === "fulfilled") {
        value = state.value;
        break;
      }
      if (state.status === "rejected")
        throw new ProgramError(state.error.message);
      if (pending.size === 0)
        throw new ProgramError("Program is stuck with no pending tool");

      // Exactly one completion, followed by a full guest drain. Do not resolve
      // all ready tasks together or race ordinary Node promises here. The SDK
      // replays journal notifications in order, including compound child tasks.
      const selected = yield* select(Object.fromEntries(pending));
      const outcome = yield* selected.future;
      pending.delete(selected.tag);
      guest.deliver(selected.tag, outcome);
    }
  } catch (error) {
    failure = {error};
    stopReason =
      error instanceof InterruptedError
        ? error
        : new InterruptedError("Program stopped");
  } finally {
    // No child can call back into the VM. Dispose it before cleanup waits.
    guest?.dispose();
    for (const task of pending.values()) task.interrupt(stopReason);
    const settled = yield* allSettled([...pending.values()]);
    // Infrastructure failures must not disappear merely because a program
    // returned without awaiting a tool that had already failed in the host.
    const failed = settled.find(
      (result) =>
        result.status === "rejected" &&
        result.reason !== stopReason &&
        !(result.reason instanceof InterruptedError),
    );
    if (
      failed?.status === "rejected" &&
      (!failure || failure.error instanceof ProgramError)
    ) {
      failure = {error: failed.reason};
    }
  }
  if (failure) throw failure.error;
  return value;
}
