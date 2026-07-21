import {type GenericCall, TerminalError} from "@restatedev/restate-sdk";
import {
  type Channel,
  call,
  gen,
  type Operation,
  run,
  select,
  spawn,
} from "@restatedev/restate-sdk-gen";
import type {
  DurableSource,
  LLMChunk,
  Next,
  StepContext,
} from "./agent_framework";
import {llmFetch} from "./utils";

// Signal name used to propagate cancellation to a downstream `ctx.call`. It must
// match the interrupt signal the called object listens for.
const INTERRUPT = "interrupt";

// Build a StepContext bound to `stopChannel`. Each operation races the stop
// channel, so sending on the channel aborts the in-flight operation: `run`
// aborts through its AbortSignal and `call` propagates an interrupt downstream.
// This is the one durable primitive the framework provides — the turn loop that
// feeds the stop channel lives in the caller (see the example's `run` handler).
export function makeStepContext(stopChannel: Channel<void>): StepContext {
  // Wrap the restate functions in StepContext
  // while handling the stopChannel depending on the semantics we want.

  const stepContextRun = <T>(
    closure: (abortSignal: AbortSignal) => Promise<T>,
  ) =>
    spawn(
      gen(function* () {
        const abortController = new AbortController();
        const runFut = run(() => closure(abortController.signal), {
          name: "step-context-run",
        });
        const selectResult = yield* select({
          runFut,
          stop: stopChannel.receive,
        });

        if (selectResult.tag === "runFut") {
          // We're all good
          return yield* selectResult.future;
        } else {
          // While running, we got the stop signal, so let's fire the abort controller here.
          abortController.abort();
          // Let's wait the run fut to guarantee that when this future is done, nothing is running anymore.
          let runResult: string;
          try {
            yield* runFut;
            runResult = "success";
          } catch (e) {
            // Ignore it
            runResult = `failure ${e}`;
          }
          throw new TerminalError(
            `framework cancellation. Run completed with ${runResult}`,
          );
        }
      }),
    );

  const stepContextCall = <REQ, RES>(c: GenericCall<REQ, RES>) =>
    spawn(
      gen(function* () {
        const callFut = call(c);
        const selectResult = yield* select({
          callFut,
          stop: stopChannel.receive,
        });

        if (selectResult.tag === "callFut") {
          // We're all good
          return yield* selectResult.future;
        } else {
          // Here we can take the actions we want to take on cancellation
          // E.g. we can propagate the interrupt downstream to the call future
          (yield* callFut.invocation).signal(INTERRUPT).resolve();
          // and we can await for the call to complete anyway, ignoring its result
          try {
            yield* callFut;
          } catch {
            // Ignore it
          }
          throw new TerminalError("framework cancellation");
        }
      }),
    );

  const stepContextPrompt = function* (
    prompt: string,
  ): Operation<DurableSource<LLMChunk>> {
    // Lives only in this process's memory — it is NOT restored on replay. After
    // a crash/replay we re-enter with `stream` undefined, which is how we detect
    // that the live source is gone and report `aborted`.
    let stream: AsyncGenerator<LLMChunk> | undefined;
    yield* stepContextRun(async (_signal) => {
      stream = llmFetch(prompt);
    });

    // Each pull is wrapped in a durable run, so every chunk we yield is recorded
    // in the journal and replayed verbatim without touching the live generator.
    return {
      next: () =>
        stepContextRun<Next<LLMChunk>>(async (_signal) => {
          // No live stream (replaying after a restart): we can't safely re-run
          // the non-deterministic source, so report it as aborted.
          if (!stream) {
            return {type: "aborted"};
          }
          const next = await stream.next();
          if (next.done) {
            return {type: "done"};
          }
          return {type: "next", value: next.value};
        }),
    };
  };

  return {
    run: stepContextRun,
    call: stepContextCall,
    prompt: stepContextPrompt,
  };
}
