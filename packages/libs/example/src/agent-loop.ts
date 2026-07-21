// The concrete agent loop for the example. It owns the model -> tools -> model
// policy and executes tools as local durable Restate operations.
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
  sleep,
  spawn,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage, ToolModelMessage} from "ai";
import {model as callModel, type ToolCall} from "./model.js";

export type AgentLoopInput = {
  agentId: string;
  messages: ModelMessage[];
};

export type AgentLoopResult =
  | {status: "completed"; text: string}
  | {status: "failed"; error: string};

export type ToolOutcome =
  | {call: ToolCall; status: "succeeded"; result: string}
  | {call: ToolCall; status: "failed"; error: string};

const MAX_ROUNDS = 8;
const MAX_TOOL_CALLS = 24;

async function getWeather(city: string, signal: AbortSignal) {
  await setTimeout(200, undefined, {signal});
  return {city, temp: 22, condition: "sunny"};
}

function* runTool(call: ToolCall): Operation<ToolOutcome> {
  if (call.toolName === "sleep") {
    const {durationSeconds} = call.input;
    yield* sleep(durationSeconds * 1_000, "sleep");
    return {
      call,
      status: "succeeded",
      result: `Slept for ${durationSeconds} seconds`,
    };
  }

  const city = call.input.city;
  try {
    const weather = yield* run((opts) => getWeather(city, opts.signal), {
      name: "getWeather",
      retry: {
        maxAttempts: 3,
        initialInterval: 200,
        maxInterval: 2_000,
        exponentiationFactor: 2,
      },
    });
    return {
      call,
      status: "succeeded",
      result: `${weather.temp}°C, ${weather.condition} in ${weather.city}`,
    };
  } catch (error) {
    if (error instanceof InterruptedError || error instanceof TerminalError) {
      throw error;
    }
    return {
      call,
      status: "failed",
      error: `getWeather failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function observe(messages: ModelMessage[], note: string): void {
  messages.push({role: "user", content: note});
}

// Run model -> tools -> model until there is a final answer.
export function* agentLoop({
  agentId,
  messages: context,
}: AgentLoopInput): Operation<AgentLoopResult> {
  const messages = [...context];
  let toolCallCount = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const action = yield* callModel(agentId, messages);

    if (action.type === "error") {
      observe(
        messages,
        `Your last response could not be used (${action.message}). Try again with the available tools or give a final answer.`,
      );
      continue;
    }

    if (action.type === "text") {
      if (!action.content.trim()) {
        observe(
          messages,
          "Your last response was empty. Call a tool or give a final answer.",
        );
        continue;
      }
      return {status: "completed", text: action.content};
    }

    toolCallCount += action.calls.length;
    if (toolCallCount > MAX_TOOL_CALLS) {
      return {
        status: "failed",
        error: `agent exceeded its ${MAX_TOOL_CALLS}-tool-call budget`,
      };
    }

    messages.push(action.message);
    // Spawn every call before joining any of them. Interrupting the surrounding
    // agent loop cascades through the complete tool batch.
    const outcomes = yield* all(
      action.calls.map((call) => spawn(runTool(call))),
    );
    const toolMessage: ToolModelMessage = {
      role: "tool",
      content: outcomes.map((outcome): ToolModelMessage["content"][number] => ({
        type: "tool-result",
        toolCallId: outcome.call.toolCallId,
        toolName: outcome.call.toolName,
        output: {
          type: "json",
          value:
            outcome.status === "succeeded"
              ? {ok: true, result: outcome.result}
              : {ok: false, error: outcome.error},
        },
      })),
    };
    messages.push(toolMessage);
  }

  return {
    status: "failed",
    error: `agent did not finish within ${MAX_ROUNDS} rounds`,
  };
}
