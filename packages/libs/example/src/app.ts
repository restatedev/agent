// Example service: a weather agent.
//
// A plain Restate virtual object. The `run` handler drives one turn: it spawns a
// `step` and selects it against the interrupt/steering signals raised by the
// shared `interrupt`/`steer` handlers. There is no separate step-context — the
// step just uses Restate's `run` directly, and interrupting it is Restate's
// native `task.interrupt()`: it throws into the step and aborts the AbortSignal
// of its in-flight `run`, so a tool is cancelled with no extra plumbing.
//
// The only things borrowed from @restate-agents/core are the durable LLM stream
// helpers. Set OPENAI_API_KEY in the environment before running.

import {setTimeout} from "node:timers/promises";
import {durableSource, llmFetch} from "@restate-agents/core";
import {serve, TerminalError} from "@restatedev/restate-sdk";
import {
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

const INTERRUPT = "interrupt";
const STEERING = "steering";

// The running turn's invocation id, so the shared handlers can signal it.
type TurnState = {turnId: string};

// A (mock) weather tool. It takes the run's AbortSignal, so interrupting the
// step cancels the in-flight call instead of waiting for it.
async function getWeather(city: string, signal: AbortSignal) {
  await setTimeout(200, undefined, {signal}); // stand-in for a network call
  return {city, temp: 22, condition: "sunny"};
}

// One step: stream a completion and act on each chunk. Returning true ends the
// turn. Every chunk pulled and every tool run is journaled, so a replay after a
// crash re-emits the same sequence instead of re-prompting the model.
function* step(): Operation<boolean> {
  const stream = yield* durableSource(() =>
    llmFetch("What's the weather in Paris? Reason briefly, then answer."),
  );

  while (true) {
    const res = yield* stream.next();
    if (res.type !== "next") {
      break; // "done" (stream ended) or "aborted" (replayed past the stream)
    }
    const chunk = res.value;

    if (chunk.type === "tool_call") {
      // Durable + abortable: the run's signal fires if the step is interrupted.
      const weather = yield* run((opts) =>
        getWeather(chunk.args.city, opts.signal),
      );
      console.log(`🔧 ${chunk.name}:`, weather);
    } else {
      console.log(`💬 ${chunk.content}`);
    }
  }

  return true;
}

const weatherAgent = object({
  name: "weatherAgent",
  handlers: {
    // Drive one turn: spawn the step and select it against the control signals.
    //   - step returns true -> the turn is done
    //   - interrupt         -> interrupt the step, then end the turn
    //   - steer             -> interrupt the step, then run a fresh one
    *run(): Operation<void> {
      // Record which invocation runs the turn so the shared handlers can signal it.
      state<TurnState>().set("turnId", handlerRequest().id);

      const interrupt = signal<void>(INTERRUPT);
      let steering = signal<void>(STEERING);

      while (true) {
        const task = spawn(step());
        const selected = yield* select({step: task, interrupt, steering});

        if (selected.tag === "step") {
          if (yield* selected.future) {
            break;
          }
        } else if (selected.tag === "interrupt") {
          // Native interrupt: aborts the step's in-flight run and throws into it.
          task.interrupt();
          try {
            yield* task; // join so the step's finally/catch runs
          } catch {
            // Swallow the interrupt.
          }
          break;
        } else {
          // steering: interrupt the current step, then loop to run a fresh one.
          task.interrupt();
          try {
            yield* task;
          } catch {
            // Swallow the interrupt.
          }
          steering = signal<void>(STEERING); // re-arm for the next steer
        }
      }

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
    // Interruption is driven explicitly via task.interrupt(), so disable
    // Restate's implicit invocation cancellation.
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
