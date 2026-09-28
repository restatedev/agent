// A stand-in weather lookup: a journaled side effect with retries, and the
// simplest example of a tool.

import {setTimeout} from "node:timers/promises";

import {z} from "zod";

import {defineAgentTool, toolRun} from "../tool-api/index.js";

export const getWeatherTool = defineAgentTool({
  name: "getWeather",
  description:
    "Get the current weather for one city. Call once per city; independent city lookups can run in parallel.",
  inputSchema: z.object({
    city: z
      .string()
      .describe("City name, optionally including state or country."),
  }),
  *run({city}) {
    return yield* toolRun(
      "getWeather",
      async ({signal}) => {
        await setTimeout(200, undefined, {signal});
        const temp = 10 + Math.floor(Math.random() * 31);
        return `${temp}°C, sunny in ${city}`;
      },
      {
        maxAttempts: 3,
        initialInterval: 200,
        maxInterval: 2_000,
        exponentiationFactor: 2,
      },
    );
  },
});
