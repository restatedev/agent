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
import {z} from "zod";
import {model as callModel, type ToolCall, type ToolManifest} from "./model.js";

export type AgentLoopInput = {
  agentId: string;
  messages: ModelMessage[];
};

export type AgentLoopResult =
  | {status: "completed"; text: string}
  | {status: "failed"; error: string};

type ToolOutcome =
  | {call: ToolCall; status: "succeeded"; result: string}
  | {call: ToolCall; status: "failed"; error: string};

type ToolExecution =
  | {status: "succeeded"; result: string}
  | {status: "failed"; error: string};

type AgentTool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute(input: unknown): Operation<ToolExecution>;
};

const MAX_ROUNDS = 8;
const MAX_TOOL_CALLS = 24;

function validationMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function defineAgentTool<
  const Name extends string,
  Schema extends z.ZodType,
>(definition: {
  name: Name;
  description: string;
  inputSchema: Schema;
  run(input: z.output<Schema>): Operation<ToolExecution>;
}): AgentTool & Pick<typeof definition, "name" | "inputSchema"> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    *execute(input: unknown): Operation<ToolExecution> {
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          status: "failed",
          error: `invalid input: ${validationMessage(parsed.error)}`,
        };
      }
      return yield* definition.run(parsed.data);
    },
  };
}

const getWeatherTool = defineAgentTool({
  name: "getWeather",
  description:
    "Get the current weather for one city. Call once per city; independent city lookups can run in parallel.",
  inputSchema: z.object({
    city: z
      .string()
      .describe("City name, optionally including state or country."),
  }),
  *run({city}): Operation<ToolExecution> {
    try {
      const weather = yield* run(
        async ({signal}) => {
          await setTimeout(200, undefined, {signal});
          return {city, temp: 22, condition: "sunny"};
        },
        {
          name: "getWeather",
          retry: {
            maxAttempts: 3,
            initialInterval: 200,
            maxInterval: 2_000,
            exponentiationFactor: 2,
          },
        },
      );
      return {
        status: "succeeded",
        result: `${weather.temp}°C, ${weather.condition} in ${weather.city}`,
      };
    } catch (error) {
      if (error instanceof InterruptedError || error instanceof TerminalError) {
        throw error;
      }
      return {
        status: "failed",
        error: `getWeather failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

const sleepTool = defineAgentTool({
  name: "sleep",
  description: "Wait durably for a requested duration before continuing.",
  inputSchema: z.object({
    durationSeconds: z
      .number()
      .int()
      .min(1)
      .max(300)
      .describe("How long to sleep, from 1 to 300 seconds."),
  }),
  *run({durationSeconds}): Operation<ToolExecution> {
    yield* sleep(durationSeconds * 1_000, "sleep");
    return {
      status: "succeeded",
      result: `Slept for ${durationSeconds} seconds`,
    };
  },
});

const STATIC_TOOLS = [getWeatherTool, sleepTool] as const;

function toManifest(tool: AgentTool): ToolManifest {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema, {target: "draft-7"}),
  };
}

function* executeTool(
  tools: readonly AgentTool[],
  call: ToolCall,
): Operation<ToolOutcome> {
  const tool = tools.find((candidate) => candidate.name === call.toolName);
  if (!tool) {
    return {
      call,
      status: "failed",
      error: `unknown tool: ${call.toolName}`,
    };
  }

  return {call, ...(yield* tool.execute(call.input))};
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
  const tools = STATIC_TOOLS;
  const manifests = tools.map(toManifest);
  let toolCallCount = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const action = yield* callModel(agentId, messages, manifests);

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
      action.calls.map((call) => spawn(executeTool(tools, call))),
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
