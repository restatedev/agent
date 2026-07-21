import {type GenericCall, TerminalError} from "@restatedev/restate-sdk";
import {
  allSettled,
  type Channel,
  call,
  channel,
  gen,
  handlerRequest,
  invocation,
  type Operation,
  object,
  run,
  select,
  sharedState,
  signal,
  spawn,
  state,
} from "@restatedev/restate-sdk-gen";
import type {
  Agent,
  DurableSource,
  LLMChunk,
  Next,
  StepContext,
} from "./agent_framework";
import {llmFetch} from "./utils";

const INTERRUPT = "interrupt";
const STEERING = "steering";

type AgentState = {turnId: string};

export function makeAgentObject(agent: Agent) {
  return object({
    name: agent.name,
    handlers: {
      *doTurn() {
        state<AgentState>().set("turnId", handlerRequest().id);
        yield* doTurn(agent);
        state<AgentState>().clear("turnId");
      },

      // Two handlers that help out to send signals
      *interrupt() {
        const id = yield* sharedState<AgentState>().get("turnId");
        if (!id) {
          throw new TerminalError("No running turn");
        }
        invocation(id).signal(INTERRUPT).resolve();
      },
      *steer() {
        const id = yield* sharedState<AgentState>().get("turnId");
        if (!id) {
          throw new TerminalError("No running turn");
        }
        invocation(id).signal(STEERING).resolve();
      },
    },
    options: {
      // We don't use restate cancellation at all,
      // so disable implicit cancellation for safety to avoid misusage.
      explicitCancellation: true,
      handlers: {
        interrupt: {shared: true},
        steer: {shared: true},
      },
    },
  });
}

// Entrypoint of the turn business logic
function* doTurn(agent: Agent) {
  const interrupt = signal<void>(INTERRUPT);
  let steering = signal<void>(STEERING);

  // -- pre-turn
  // All settled will not throw in case of errors.
  yield* allSettled(agent.preTurnHooks?.map((hook) => spawn(hook())) ?? []);

  while (true) {
    // We use this stop channel to stop a step execution.
    const stopChannel = channel<void>();

    // Spawn the step
    const stepFut = spawn(step(agent, stopChannel));

    // Wait it alongside with interruption and steering signals.
    const selectResult = yield* select({
      stepFut,
      interrupt,
      steering,
    });

    if (selectResult.tag === "stepFut") {
      const done = yield* selectResult.future;
      // If step returned is true, we break the loop
      if (done) {
        break;
      }
    } else if (selectResult.tag === "interrupt") {
      // We got the interrupt signal, let's propagate it to the step and wait for it to exit.
      yield* stopChannel.send();
      try {
        yield* stepFut;
      } catch {
        // Just ignore failure
      }

      // Interruption breaks the loop
      break;
    } else if (selectResult.tag === "steering") {
      // We got the steering signal, let's propagate it to the step and wait for it to exit.
      yield* stopChannel.send();
      try {
        yield* stepFut;
      } catch {
        // Just ignore failure
      }

      // Steering is a stream, so if we consumed the latest steering signal,
      // let's go recreate a new fut
      steering = signal<void>(INTERRUPT);

      // On steering, we run some specific business logic and continue to loop
    }
  }

  // -- post-turn
  yield* allSettled(agent.postTurnHooks?.map((hook) => spawn(hook())) ?? []);
}

// True means exit the loop
function* step(agent: Agent, stopChannel: Channel<void>): Operation<boolean> {
  // For each step, we:
  // - Run pre-step hooks
  // - Run the actual step
  // - Run post-step hooks

  // -- pre-step
  yield* allSettled(agent.preStepHook?.map((hook) => spawn(hook())) ?? []);

  try {
    // -- step
    const stepContext = makeStepContext(stopChannel);
    return yield* agent.step(stepContext);
  } catch (e) {
    // Just logging here
    console.log(`Step failed! ${e}`);
    throw e;
  } finally {
    // -- post-step

    // Don't care about signals, run these post-step hooks no matter what
    yield* allSettled(agent.postStepHooks?.map((hook) => spawn(hook())) ?? []);
  }
}

function makeStepContext(stopChannel: Channel<void>): StepContext {
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
