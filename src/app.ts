import {setTimeout} from "node:timers/promises";
import {serve, TerminalError} from "@restatedev/restate-sdk";
import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Agent, StepContext} from "./agent_framework";
import {makeAgentObject} from "./service";

// Bunch of hooks to print when executed
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

const basicAgent: Agent = {
  name: "basicAgent",
  ...consoleHooks,

  *step(_ctx: StepContext): Operation<boolean> {
    console.log("Step executed");
    return true;
  },
};

const agentWithFailures: Agent = {
  name: "agentWithFailures",
  ...consoleHooks,

  *step(ctx: StepContext): Operation<boolean> {
    const result = yield* ctx.run(async () => {
      if (Math.random() < 0.7) {
        throw new Error("transient network blip");
      }
      return "fetched";
    });
    console.log("Got result:", result);
    return true;
  },
};

const agentWithAbortableStep: Agent = {
  name: "agentWithAbortableStep",
  ...consoleHooks,

  *step(ctx: StepContext): Operation<boolean> {
    const result = yield* ctx.run(async (signal) => {
      try {
        await setTimeout(30_000, undefined, {signal});
      } catch {
        throw new TerminalError("sleep aborted!");
      }
      return "completed";
    });
    console.log("Result:", result);
    return true;
  },
};

const agentWithLLM: Agent = {
  name: "agentWithLLM",
  ...consoleHooks,

  *step(ctx: StepContext): Operation<boolean> {
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
        console.log(`Got text: ${chunk.content}`);
      }
    }
    return true;
  },
};

serve({
  services: [
    makeAgentObject(basicAgent),
    makeAgentObject(agentWithFailures),
    makeAgentObject(agentWithAbortableStep),
    makeAgentObject(agentWithLLM),
  ],
});
