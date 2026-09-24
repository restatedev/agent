// Manual fault-injection fixture. No model calls, credentials, or real tools.
import {setTimeout} from "node:timers/promises";
import {serve} from "@restatedev/restate-sdk";
import {run, service} from "@restatedev/restate-sdk-gen";
import type {Json, Outcome} from "../src/ptc/guest.js";
import {executeProgram} from "../src/ptc/runtime.js";

serve({
  port: 19880,
  services: [
    service({
      name: "PTCRestart",
      handlers: {
        *execute({source}: {source: string}) {
          return yield* executeProgram(source, {
            names: ["lookup", "score", "checkpoint"],
            *execute(request) {
              return yield* run(
                async (): Promise<Outcome> => {
                  const input = request.args[0] as {
                    key: string;
                    amount: number;
                  };
                  console.log(`PTC_EFFECT:${request.name}`);
                  let value: Json;
                  if (request.name === "lookup") {
                    await setTimeout(input.key === "a" ? 180 : 20);
                    value = {
                      key: input.key,
                      amount: input.key === "a" ? 40 : 70,
                    };
                  } else if (request.name === "score") {
                    value = input.amount * 2;
                  } else {
                    console.log(`PTC_CHECKPOINT:${JSON.stringify(input)}`);
                    await setTimeout(2500);
                    value = null;
                  }
                  return {ok: true, value};
                },
                {name: `${request.id}:${request.name}`},
              );
            },
          });
        },
      },
    }),
  ],
});
