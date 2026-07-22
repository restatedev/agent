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
  client,
  InterruptedError,
  type Operation,
  run,
  sendClient,
  signal,
  sleep,
  spawn,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage, ToolModelMessage} from "ai";
import {z} from "zod";
import {Agent} from "./agent.js";
import {approvalSignalName} from "./agent-approval.js";
import type {ToolCall, ToolManifest} from "./model.js";
import {callModel} from "./model-gateway.js";
import type {ApprovalDecision} from "./types.js";

export type AgentLoopInput = {
  agentId: string;
  turnId: string;
  messages: ModelMessage[];
};

export type AgentLoopResult =
  | {status: "completed"; text: string}
  | {status: "failed"; error: string};

type ToolExecution =
  | {status: "succeeded"; result: string}
  | {status: "failed"; error: string};

type ToolOutcome = ToolExecution & {call: ToolCall};

type AgentToolContext = {
  agentId: string;
  turnId: string;
  toolCallId: string;
};

type AgentTool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute(input: unknown, context: AgentToolContext): Operation<ToolExecution>;
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
  run(
    input: z.output<Schema>,
    context: AgentToolContext,
  ): Operation<ToolExecution>;
}): AgentTool & Pick<typeof definition, "name" | "inputSchema"> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    *execute(
      input: unknown,
      context: AgentToolContext,
    ): Operation<ToolExecution> {
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          status: "failed",
          error: `invalid input: ${validationMessage(parsed.error)}`,
        };
      }
      return yield* definition.run(parsed.data, context);
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

const humanApprovalTool = defineAgentTool({
  name: "humanApproval",
  description:
    "Pause durably and ask a human to approve a proposed action. Use this when explicit human authorization is required. Call it by itself before any tools that depend on the decision.",
  inputSchema: z.object({
    question: z
      .string()
      .min(1)
      .describe("The specific action or decision the human should approve."),
  }),
  *run({question}, context): Operation<ToolExecution> {
    const request = {
      approvalId: context.toolCallId,
      turnId: context.turnId,
      question,
    };
    try {
      const registered = yield* client(Agent, context.agentId).requestApproval(
        request,
      );
      if (!registered) {
        return {
          status: "failed",
          error:
            "human approval could not be registered because the turn is no longer active",
        };
      }

      const decision = yield* signal<ApprovalDecision>(
        approvalSignalName(context.toolCallId),
      );
      const reason = decision.reason ? ` Reason: ${decision.reason}` : "";
      return {
        status: "succeeded",
        result:
          decision.decision === "approved"
            ? `Human approved the request.${reason}`
            : `Human rejected the request.${reason}`,
      };
    } finally {
      yield* sendClient(Agent, context.agentId).cancelApproval({
        approvalId: context.toolCallId,
        turnId: context.turnId,
      });
    }
  },
});

const STATIC_TOOLS = [getWeatherTool, sleepTool, humanApprovalTool] as const;

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
  context: Omit<AgentToolContext, "toolCallId">,
): Operation<ToolOutcome> {
  const tool = tools.find((candidate) => candidate.name === call.toolName);
  if (!tool) {
    return {
      call,
      status: "failed",
      error: `unknown tool: ${call.toolName}`,
    };
  }

  return {
    call,
    ...(yield* tool.execute(call.input, {
      ...context,
      toolCallId: call.toolCallId,
    })),
  };
}

// Run model -> tools -> model until there is a final answer.
export function* agentLoop({
  agentId,
  turnId,
  messages: context,
}: AgentLoopInput): Operation<AgentLoopResult> {
  const messages = [...context];
  const tools = STATIC_TOOLS;
  const manifests = tools.map(toManifest);
  const toolContext = {agentId, turnId};
  let toolCallCount = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const action = yield* callModel(agentId, messages, manifests);

    if (action.type === "error") {
      messages.push({
        role: "user",
        content: `Your last response could not be used (${action.message}). Try again with the available tools or give a final answer.`,
      });
      continue;
    }

    if (action.type === "text") {
      if (!action.content.trim()) {
        messages.push({
          role: "user",
          content:
            "Your last response was empty. Call a tool or give a final answer.",
        });
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
      action.calls.map((call) => spawn(executeTool(tools, call, toolContext))),
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
