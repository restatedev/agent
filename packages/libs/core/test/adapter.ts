import {type Context, TerminalError} from "@restatedev/restate-sdk";
import {execute, gen, run} from "@restatedev/restate-sdk-gen";

import type {GuestLimits, Json, Outcome} from "../src/ptc/guest.js";
import {executeProgram} from "../src/ptc/runtime.js";

// Runs the production driver inside the real SDK scheduler. Each supplied test
// tool owns a run, just as concrete agent tools own their durable operations.
export function executeWithTools(
  context: Context,
  source: string,
  tools: Record<string, (...args: Json[]) => Promise<Json>>,
  limits?: GuestLimits,
): Promise<Json> {
  return execute(
    context,
    gen(function* () {
      return yield* executeProgram(
        source,
        {
          names: Object.keys(tools),
          *execute(request) {
            return yield* run(
              async (): Promise<Outcome> => {
                try {
                  return {
                    ok: true,
                    value: await tools[request.name](...request.args),
                  };
                } catch (error) {
                  if (!(error instanceof TerminalError)) throw error;
                  return {
                    ok: false,
                    error: {name: error.name, message: error.message},
                  };
                }
              },
              {name: `${request.id}:${request.name}`},
            );
          },
        },
        limits,
      );
    }),
  );
}
