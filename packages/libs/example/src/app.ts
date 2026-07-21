// Example service: a weather agent.
//
// A plain Restate virtual object with the whole turn loop written out here — no
// framework factory or turn-runner hides it. The `run` handler drives one turn:
// it runs hooks, then repeatedly runs a `step` with an abortable context,
// selecting the step against the interrupt/steering signals raised by the shared
// `interrupt`/`steer` handlers. The only thing borrowed from @restate-agents/core
// is `makeStepContext`, which gives each step a durable, abortable run/prompt.
//
// Set OPENAI_API_KEY in the environment before running.

import {setTimeout} from "node:timers/promises";
import {makeStepContext, type StepContext} from "@restate-agents/core";
import {serve, TerminalError} from "@restatedev/restate-sdk";
import {
  allSettled,
  type Channel,
  channel,
  handlerRequest,
  invocation,
  type Operation,
  object,
  select,
  sharedState,
  signal,
  spawn,
  state,
} from "@restatedev/restate-sdk-gen";

// Signal names used to control a running turn. INTERRUPT must match the name
// the framework's ctx.call propagation uses.
const INTERRUPT = "interrupt";
const STEERING = "steering";

// The running turn's invocation id, so the shared handlers can signal it.
type TurnState = {turnId: string};

// A hook is a durable side effect run at a turn/step boundary.
type Hook = () => Operation<void>;

// Run hooks concurrently and swallow their failures, so a bad hook can't take
// down the turn.
function* runHooks(hooks: Hook[]): Operation<void> {
  yield* allSettled(hooks.map((hook) => spawn(hook())));
}

const preTurnHooks: Hook[] = [
  function* () {
    console.log("[turn] start");
  },
];
const postTurnHooks: Hook[] = [
  function* () {
    console.log("[turn] done");
  },
];
const preStepHooks: Hook[] = [
  function* () {
    console.log("[step] start");
  },
];
const postStepHooks: Hook[] = [
  function* () {
    console.log("[step] done");
  },
];

// A (mock) weather tool. It takes the step's AbortSignal, so an interrupt/steer
// cancels the in-flight call instead of waiting for it.
async function getWeather(city: string, signal: AbortSignal) {
  await setTimeout(200, undefined, {signal}); // stand-in for a network call
  return {city, temp: 22, condition: "sunny"};
}

// One step: stream a completion and act on each chunk. Returning true ends the
// turn. Every chunk pulled and every tool run is journaled, so a replay after a
// crash re-emits the same sequence instead of re-prompting the model.
function* step(ctx: StepContext): Operation<boolean> {
  const stream = yield* ctx.prompt(
    "What's the weather in Paris? Reason briefly, then answer.",
  );

  while (true) {
    const res = yield* stream.next();
    if (res.type !== "next") {
      break; // "done" (stream ended) or "aborted" (replayed past the stream)
    }
    const chunk = res.value;

    if (chunk.type === "tool_call") {
      // Durable + abortable: the signal fires if the turn is interrupted/steered.
      const weather = yield* ctx.run((signal) =>
        getWeather(chunk.args.city, signal),
      );
      console.log(`🔧 ${chunk.name}:`, weather);
    } else {
      console.log(`💬 ${chunk.content}`);
    }
  }

  return true;
}

// Run a single step wrapped in its step hooks, with an abortable context bound
// to `stopChannel`. True means end the turn.
function* runStep(stopChannel: Channel<void>): Operation<boolean> {
  yield* runHooks(preStepHooks);
  try {
    const ctx = makeStepContext(stopChannel);
    return yield* step(ctx);
  } finally {
    // Post-step hooks run no matter what, including on stop.
    yield* runHooks(postStepHooks);
  }
}

const weatherAgent = object({
  name: "weatherAgent",
  handlers: {
    // Drive one turn. Runs pre-turn hooks, then loops: run the step with an
    // abortable context and select it against the interrupt/steering signals.
    //   - step returns true -> the turn is done
    //   - interrupt         -> stop the step, then end the turn
    //   - steer             -> stop the step, then run a fresh one
    *run(): Operation<void> {
      // Record which invocation runs the turn so the shared handlers can signal it.
      state<TurnState>().set("turnId", handlerRequest().id);

      const interrupt = signal<void>(INTERRUPT);
      let steering = signal<void>(STEERING);

      yield* runHooks(preTurnHooks);

      while (true) {
        // A per-step channel that stops the step (and aborts its tools) on a signal.
        const stopChannel = channel<void>();
        const stepFut = spawn(runStep(stopChannel));

        const selected = yield* select({stepFut, interrupt, steering});

        if (selected.tag === "stepFut") {
          if (yield* selected.future) {
            break;
          }
        } else if (selected.tag === "interrupt") {
          yield* stopChannel.send();
          try {
            yield* stepFut;
          } catch {
            // The step throws framework-cancellation on stop; ignore it.
          }
          break;
        } else {
          // steering: stop the current step, then loop to run a fresh one.
          yield* stopChannel.send();
          try {
            yield* stepFut;
          } catch {
            // Ignore the cancellation.
          }
          steering = signal<void>(STEERING); // re-arm for the next steer
        }
      }

      yield* runHooks(postTurnHooks);

      state<TurnState>().clear("turnId");
    },

    // Shared handlers can run while a turn is in flight to control it.
    *interrupt(): Operation<void> {
      const id = yield* sharedState<TurnState>().get("turnId");
      if (!id) {
        throw new TerminalError("No running turn");
      }
      invocation(id).signal(INTERRUPT).resolve();
    },
    *steer(): Operation<void> {
      const id = yield* sharedState<TurnState>().get("turnId");
      if (!id) {
        throw new TerminalError("No running turn");
      }
      invocation(id).signal(STEERING).resolve();
    },
  },
  options: {
    // We drive cancellation ourselves via the stop channel, so disable Restate's
    // implicit cancellation.
    explicitCancellation: true,
    handlers: {
      interrupt: {shared: true},
      steer: {shared: true},
    },
  },
});

serve({
  services: [weatherAgent],
});
