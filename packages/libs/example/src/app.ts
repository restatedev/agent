// Example service for @restate-agents/core.
//
// One self-contained agent: a weather assistant. It streams a completion from a
// real LLM (OpenAI, wired up inside @restate-agents/core) and processes each
// streamed chunk durably — printing the model's messages and running a weather
// tool whenever the model asks for one.
//
// Set OPENAI_API_KEY in the environment before running.

import {
  type Agent,
  makeAgentObject,
  type StepContext,
} from "@restate-agents/core";
import {serve} from "@restatedev/restate-sdk";
import type {Operation} from "@restatedev/restate-sdk-gen";

// A (mock) weather tool the agent can call, executed as a durable ctx.run step.
async function getWeather(city: string) {
  // Stand-in for a real weather API call.
  return {city, temp: 22, condition: "sunny"};
}

const weatherAgent: Agent = {
  name: "weatherAgent",

  // Lifecycle hooks fire around each turn; here they just log.
  preTurnHooks: [
    function* () {
      console.log("[turn] start");
    },
  ],
  postTurnHooks: [
    function* () {
      console.log("[turn] done");
    },
  ],

  *step(ctx: StepContext): Operation<boolean> {
    // Stream a real LLM completion and act on each chunk as it arrives. Every
    // chunk pulled from the stream is journaled by the framework, so a replay
    // after a crash re-emits the same sequence instead of re-prompting the model.
    const stream = yield* ctx.prompt(
      "What's the weather in Paris? Reason briefly, then answer.",
    );

    while (true) {
      const res = yield* stream.next();
      if (res.type === "done" || res.type === "aborted") {
        break;
      }
      const chunk = res.value;

      if (chunk.type === "tool_call") {
        // Run the requested tool as a durable side effect.
        const weather = yield* ctx.run(() => getWeather(chunk.args.city));
        console.log(`🔧 ${chunk.name}:`, weather);
      } else {
        console.log(`💬 ${chunk.content}`);
      }
    }

    return true; // one turn is enough for this example
  },
};

serve({
  services: [makeAgentObject(weatherAgent)],
});
