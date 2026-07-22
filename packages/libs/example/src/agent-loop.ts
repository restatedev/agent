// The concrete agent loop for the example. It owns the model -> tools -> model
// policy and executes tools as local durable Restate operations.
//
// The surrounding Turn service supplies the conversation context and owns hard
// interruption. Steering is handled here so model/tool state is not discarded.

import {setTimeout} from "node:timers/promises";
import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import {
  all,
  allSettled,
  client,
  type Future,
  InterruptedError,
  type Operation,
  run,
  select,
  sendClient,
  signal,
  sleep,
  spawn,
  type Task,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage, ToolModelMessage} from "ai";
import {z} from "zod";
import {Agent} from "./agent.js";
import {approvalSignalName} from "./agent-approval.js";
import type {ModelResult, ToolCall, ToolManifest} from "./model.js";
import {callModel} from "./model-gateway.js";
import type {ApprovalDecision} from "./types.js";

export type AgentLoopInput = {
  agentId: string;
  turnId: string;
  messages: ModelMessage[];
};

export type AgentLoopResult = (
  | {status: "completed"; text: string}
  | {status: "failed"; error: string}
) & {consumedSteering: number};

type ToolExecution =
  | {status: "succeeded"; result: string}
  | {status: "failed"; error: string}
  | {status: "cancelled"; reason: string};

type ToolOutcome = ToolExecution & {call: ToolCall};

type ModelStep =
  | {type: "model"; action: ModelResult}
  | {type: "steering"; message: string};

type ToolStep = {
  outcomes: ToolOutcome[];
  steering?: string;
};

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
const STEERING = "steering";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function toToolMessage(outcomes: ToolOutcome[]): ToolModelMessage {
  return {
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
            : outcome.status === "failed"
              ? {ok: false, error: outcome.error}
              : {ok: false, cancelled: true, reason: outcome.reason},
      },
    })),
  };
}

// Steering supersedes an in-flight model call. Join it so cancellation reaches
// the scoped gateway before starting another model round.
function* stopModelForSteering(task: Task<unknown>): Operation<void> {
  task.interrupt();
  try {
    yield* task;
  } catch {
    // The steering instruction supersedes the abandoned model result or error.
  }
}

// Preserve completed outcomes and close every unfinished tool call with an
// explicit cancellation result. This keeps the assistant tool-call message and
// its following tool-result message protocol-complete across steering. All
// tools in this example are cancellation-safe; real irreversible tools need an
// explicit finish-or-recover policy before using this behavior.
function* stopToolsForSteering(
  tasks: Task<ToolOutcome>[],
  calls: ToolCall[],
): Operation<ToolOutcome[]> {
  for (const task of tasks) {
    task.interrupt();
  }
  const settled = yield* allSettled(tasks);
  return settled.map((result, index): ToolOutcome => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    const call = calls[index];
    return result.reason instanceof InterruptedError
      ? {call, status: "cancelled", reason: "cancelled by steering"}
      : {
          call,
          status: "failed",
          error: `tool stopped while steering: ${errorMessage(result.reason)}`,
        };
  });
}

// Race one model call against the next steering instruction. No tool work has
// started yet, so a steer can safely supersede the in-flight model call.
function* runModelStep(
  agentId: string,
  messages: ModelMessage[],
  manifests: ToolManifest[],
  steering: Future<string>,
): Operation<ModelStep> {
  const modelTask = spawn(callModel(agentId, messages, manifests));
  const selected = yield* select({steering, model: modelTask});
  if (selected.tag === "model") {
    return {type: "model", action: yield* selected.future};
  }

  const message = yield* selected.future;
  yield* stopModelForSteering(modelTask);
  return {type: "steering", message};
}

// Run one complete tool batch, or close the batch with explicit cancellation
// results before returning a steering instruction to the loop.
function* runToolStep(
  tools: readonly AgentTool[],
  calls: ToolCall[],
  context: Omit<AgentToolContext, "toolCallId">,
  steering: Future<string>,
): Operation<ToolStep> {
  const tasks = calls.map((call) => spawn(executeTool(tools, call, context)));
  const selected = yield* select({steering, tools: all(tasks)});
  if (selected.tag === "tools") {
    return {outcomes: yield* selected.future};
  }

  const message = yield* selected.future;
  return {
    outcomes: yield* stopToolsForSteering(tasks, calls),
    steering: message,
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
  let steering = signal<string>(STEERING);
  let consumedSteering = 0;
  let toolCallCount = 0;
  let modelRounds = 0;

  try {
    while (modelRounds < MAX_ROUNDS) {
      const step = yield* runModelStep(agentId, messages, manifests, steering);
      if (step.type === "steering") {
        consumedSteering += 1;
        steering = signal<string>(STEERING);
        messages.push({role: "user", content: step.message});
        continue;
      }

      const {action} = step;
      modelRounds += 1;

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
        return {
          status: "completed",
          text: action.content,
          consumedSteering,
        };
      }

      toolCallCount += action.calls.length;
      if (toolCallCount > MAX_TOOL_CALLS) {
        return {
          status: "failed",
          error: `agent exceeded its ${MAX_TOOL_CALLS}-tool-call budget`,
          consumedSteering,
        };
      }

      messages.push(action.message);
      const toolStep = yield* runToolStep(
        tools,
        action.calls,
        toolContext,
        steering,
      );
      messages.push(toToolMessage(toolStep.outcomes));

      if (toolStep.steering !== undefined) {
        consumedSteering += 1;
        steering = signal<string>(STEERING);
        messages.push({role: "user", content: toolStep.steering});
      }
    }

    return {
      status: "failed",
      error: `agent did not finish within ${MAX_ROUNDS} rounds`,
      consumedSteering,
    };
  } catch (error) {
    if (error instanceof InterruptedError || error instanceof CancelledError) {
      throw error;
    }
    return {
      status: "failed",
      error: errorMessage(error),
      consumedSteering,
    };
  }
}
