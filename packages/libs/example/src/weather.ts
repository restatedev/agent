// A tool is an ordinary Restate service. Keeping it outside the agent loop
// gives the invocation its own durability, retries, observability, and scaling
// boundary. This implementation is intentionally a deterministic mock; replace
// its body with a journaled API call in a real application.

import {
  type Operation,
  schemas,
  service,
  sleep,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";

const WeatherRequestSchema = z.object({city: z.string().min(1)});
const WeatherResultSchema = z.object({
  city: z.string(),
  temperatureCelsius: z.number(),
  condition: z.string(),
});
type WeatherRequest = z.infer<typeof WeatherRequestSchema>;
type WeatherResult = z.infer<typeof WeatherResultSchema>;

export const Weather = service({
  name: "Weather",
  handlers: {
    get: schemas(
      {input: WeatherRequestSchema, output: WeatherResultSchema},
      function* ({city}: WeatherRequest): Operation<WeatherResult> {
        // A durable delay makes the example's interrupt/steer behavior easy to
        // observe without introducing a second external API dependency.
        yield* sleep(500);
        return {city, temperatureCelsius: 22, condition: "sunny"};
      },
    ),
  },
});
