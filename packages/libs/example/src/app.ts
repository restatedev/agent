// Example service for @restate-agents/core.
//
// A single "demo" agent that exercises the framework's main capabilities:
//   - lifecycle hooks (pre/post turn, pre/post step)
//   - durable `ctx.run` side effects, including transient-failure retries
//   - abortable runs that observe the framework's AbortSignal
//   - streaming LLM prompts with tool-call dispatch
//
// The framework itself lives in @restate-agents/core; this package only wires
// one example agent into a Restate service.

import {setTimeout} from "node:timers/promises";
import {
  type Agent,
  makeAgentObject,
  type StepContext,
} from "@restate-agents/core";
import {serve, TerminalError} from "@restatedev/restate-sdk";
import type {Operation} from "@restatedev/restate-sdk-gen";

// Hooks that just log when the framework invokes them.
const consoleHooks = {
  preTurnHooks: [
    function* () {
      console.log("Pre turn hook executed");
    },
  ],
  postTurnHooks: [
    function* () {
      console.log("Post turn hook executed");
    },
  ],
  preStepHook: [
    function* () {
      console.log("Pre step hook executed");
    },
  ],
  postStepHooks: [
    function* () {
      console.log("Post step hook executed");
    },
  ],
};

const demoAgent: Agent = {
  name: "demoAgent",
  ...consoleHooks,

  *step(ctx: StepContext): Operation<boolean> {
    // 1. Durable side effect that may fail transiently. `ctx.run` is the unit
    //    of retry/replay: on failure the framework re-runs the step.
    const fetched = yield* ctx.run(async () => {
      if (Math.random() < 0.5) {
        throw new Error("transient network blip");
      }
      return "fetched context";
    });
    console.log("Durable run result:", fetched);

    // 2. Abortable run: the closure receives an AbortSignal that fires when the
    //    framework cancels the step (e.g. on an interrupt signal).
    const slept = yield* ctx.run(async (signal) => {
      try {
        await setTimeout(200, undefined, {signal});
      } catch {
        throw new TerminalError("aborted while sleeping");
      }
      return "woke up";
    });
    console.log("Abortable run result:", slept);

    // 3. Prompt the LLM and consume the streamed response, dispatching tool calls.
    const stream = yield* ctx.prompt("What's the weather in Paris?");
    while (true) {
      const chunk = yield* stream.next();
      if ("eos" in chunk) break;

      if (chunk.type === "tool_call") {
        const result = yield* ctx.run(async () => ({
          temp: 22,
          condition: "sunny",
        }));
        console.log(
          `Tool ${chunk.name}(${JSON.stringify(chunk.args)}) →`,
          result,
        );
      } else {
        console.log(`LLM text: ${chunk.content}`);
      }
    }

    // Returning true ends the turn.
    return true;
  },
};

serve({
  services: [makeAgentObject(demoAgent)],
});
