// The concrete agent loop for the example. It owns the model -> tools -> model
// policy: tool execution, error feedback, and the round budget. Model protocol
// and access live in ./model.
//
// The surrounding Turn service only supervises this work. It supplies the
// conversation context and races the loop against interrupt and steering
// signals.

import {setTimeout} from "node:timers/promises";
import {TerminalError} from "@restatedev/restate-sdk";
import {
  all,
  InterruptedError,
  type Operation,
  run,
  spawn,
} from "@restatedev/restate-sdk-gen";
import {type ModelMessage, model, type ToolCall} from "./model";

export type AgentLoopInput = {
  agentId: string;
  messages: ModelMessage[];
};

export type AgentLoopResult =
  | {status: "completed"; text: string}
  | {status: "failed"; error: string};

const MAX_ROUNDS = 8;

// The example tool is deliberately local and small. A real application can
// replace this switch with a registry or service invocations without changing
// the Turn lifecycle.
async function getWeather(city: string, signal: AbortSignal) {
  await setTimeout(200, undefined, {signal});
  return {city, temp: 22, condition: "sunny"};
}

function* runTool(call: ToolCall): Operation<string> {
  if (call.name !== "getWeather") {
    return `error: unknown tool "${call.name}"`;
  }
  const city = call.args.city;
  if (!city) {
    return 'error: getWeather requires a string "city" arg';
  }

  try {
    const weather = yield* run((opts) => getWeather(city, opts.signal), {
      name: "getWeather",
    });
    return `${weather.temp}°C, ${weather.condition} in ${weather.city}`;
  } catch (error) {
    if (error instanceof InterruptedError || error instanceof TerminalError) {
      throw error;
    }
    return `error: getWeather failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function observe(messages: ModelMessage[], note: string): void {
  messages.push({role: "user", content: note});
}

// Run model -> tools -> model until there is a final answer. The small boundary
// carries only identity (for flow control) and conversation context; model and
// tools remain concrete parts of the loop rather than injected abstractions.
export function* agentLoop({
  agentId,
  messages: context,
}: AgentLoopInput): Operation<AgentLoopResult> {
  const messages = [...context];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const action = yield* model(agentId, messages);

    if (action.type === "error") {
      observe(
        messages,
        `Your last response could not be used (${action.message}). Reply with valid protocol JSON.`,
      );
      continue;
    }

    if (action.type === "text") {
      if (!action.content) {
        observe(
          messages,
          "Your last response was empty. Call a tool or give a final answer.",
        );
        continue;
      }
      return {status: "completed", text: action.content};
    }

    // Spawn every tool before joining any of them. Interrupting the surrounding
    // agentLoop task cascades to the whole tool batch.
    const results = yield* all(
      action.calls.map((call) => spawn(runTool(call))),
    );
    messages.push({
      role: "assistant",
      content: JSON.stringify(action),
    });
    for (const [index, result] of results.entries()) {
      const call = action.calls[index];
      messages.push({
        role: "tool",
        content: JSON.stringify({name: call?.name, args: call?.args, result}),
      });
    }
  }

  return {
    status: "failed",
    error: `agent did not finish within ${MAX_ROUNDS} rounds`,
  };
}
