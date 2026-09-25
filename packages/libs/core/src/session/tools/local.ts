// Self-contained tools: they need nothing from the Agent controller.

import {setTimeout} from "node:timers/promises";

import {asyncTool} from "@restate-agents/core";
import {z} from "zod";

export const getWeather = asyncTool({
  description:
    "Get the current weather for one city. Call once per city; independent city lookups can run in parallel.",
  input: z.object({
    city: z
      .string()
      .describe("City name, optionally including state or country."),
  }),
  retry: {
    maxAttempts: 3,
    initialInterval: 200,
    maxInterval: 2_000,
    exponentiationFactor: 2,
  },
  async execute({city}, {signal}) {
    await setTimeout(200, undefined, {signal});
    const temp = 10 + Math.floor(Math.random() * 31);
    return `${temp}°C, sunny in ${city}`;
  },
});
