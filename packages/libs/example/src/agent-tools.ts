// Concrete tools available to the example agent. Each definition owns its
// model description, input schema, validation, and local durable behavior.
// The exported object is deliberately concrete rather than a generic runtime:
// Turn owns orchestration and agent-step owns foreground execution while this
// module owns tool mechanics.

import {setTimeout} from "node:timers/promises";
import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import {
  client,
  InterruptedError,
  type Operation,
  run,
  sendClient,
  signal,
  sleep,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage, ToolModelMessage} from "ai";
import {z} from "zod";
import {Agent} from "./agent.js";
import type {ToolCall, ToolManifest} from "./model.js";
import {type ApprovalDecision, approvalSignalName} from "./types.js";

type ToolExecution =
  | {status: "succeeded"; result: string}
  | {status: "failed"; error: string}
  | {status: "pending"; result: Record<string, unknown>}
  | {status: "cancel_requested"; operationId: string; reason: string};

type ToolCompletion =
  | Extract<ToolExecution, {status: "succeeded" | "failed"}>
  | {status: "cancelled"; reason: string};

export type ToolOutcome = ToolExecution & {call: ToolCall};

export type PendingEvent = {
  call: ToolCall;
  outcome: ToolCompletion;
};

export type AgentToolContext = {
  agentId: string;
  turnId: string;
};

type ToolCallContext = AgentToolContext & {
  toolCallId: string;
};

type AgentTool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute(input: unknown, context: ToolCallContext): Operation<ToolExecution>;
  complete(input: unknown, context: ToolCallContext): Operation<ToolCompletion>;
};

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
    context: ToolCallContext,
  ): Operation<ToolExecution>;
  complete?(
    input: z.output<Schema>,
    context: ToolCallContext,
  ): Operation<ToolCompletion>;
}): AgentTool & Pick<typeof definition, "name" | "inputSchema"> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    *execute(
      input: unknown,
      context: ToolCallContext,
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
    *complete(
      input: unknown,
      context: ToolCallContext,
    ): Operation<ToolCompletion> {
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          status: "failed",
          error: `invalid pending input: ${validationMessage(parsed.error)}`,
        };
      }
      if (!definition.complete) {
        return {
          status: "failed",
          error: `${definition.name} did not provide a pending completion`,
        };
      }
      return yield* definition.complete(parsed.data, context);
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
        error: `getWeather failed: ${errorMessage(error)}`,
      };
    }
  },
});

const sleepTool = defineAgentTool({
  name: "sleep",
  description:
    "Start a durable timer. The timer remains active across later agent steps, and the turn cannot finish until it completes.",
  inputSchema: z.object({
    durationSeconds: z
      .number()
      .int()
      .min(1)
      .max(300)
      .describe("How long to sleep, from 1 to 300 seconds."),
  }),
  *run({durationSeconds}, context): Operation<ToolExecution> {
    return {
      status: "pending",
      result: {
        operationId: context.toolCallId,
        status: "running",
        durationSeconds,
      },
    };
  },
  *complete({durationSeconds}): Operation<ToolCompletion> {
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
    "Request human approval for a proposed action. The request remains pending across later agent steps. Call it by itself and do not perform dependent actions until a runtime update reports approval.",
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
    return {
      status: "pending",
      result: {
        operationId: context.toolCallId,
        approvalId: context.toolCallId,
        status: "pending",
        question,
      },
    };
  },
  *complete({question: _question}, context): Operation<ToolCompletion> {
    try {
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
    } catch (error) {
      yield* sendClient(Agent, context.agentId).cancelApproval({
        approvalId: context.toolCallId,
        turnId: context.turnId,
      });
      throw error;
    }
  },
});

const cancelOperationTool = defineAgentTool({
  name: "cancelOperation",
  description:
    "Cancel one pending operation, such as a running sleep or human approval request, using the operationId from its pending result. This does not cancel completed or foreground tools.",
  inputSchema: z.object({
    operationId: z
      .string()
      .min(1)
      .describe("The operationId returned by a pending tool."),
    reason: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "Why the pending operation should be cancelled, or null when no reason was given.",
      ),
  }),
  *run({operationId, reason}): Operation<ToolExecution> {
    return {
      status: "cancel_requested",
      operationId,
      reason: reason ?? "Cancelled by the agent",
    };
  },
});

const definitions = [
  getWeatherTool,
  sleepTool,
  humanApprovalTool,
  cancelOperationTool,
] as const;

function findTool(name: string): AgentTool | undefined {
  return definitions.find((candidate) => candidate.name === name);
}

function toManifest(tool: AgentTool): ToolManifest {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema, {target: "draft-7"}),
  };
}

function toModelMessage(outcomes: ToolOutcome[]): ToolModelMessage {
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
              : outcome.status === "pending"
                ? {ok: true, pending: true, ...outcome.result}
                : {
                    ok: false,
                    error: `cancellation request for ${outcome.operationId} was not applied`,
                  },
      },
    })),
  };
}

function toRuntimeMessage({call, outcome}: PendingEvent): ModelMessage {
  const result =
    outcome.status === "succeeded"
      ? `completed successfully: ${outcome.result}`
      : outcome.status === "failed"
        ? `failed: ${outcome.error}`
        : `was cancelled: ${outcome.reason}`;
  return {
    role: "user",
    content: `[Runtime event] Pending tool ${call.toolName} (${call.toolCallId}) ${result}`,
  };
}

export const agentTools = {
  manifests: definitions.map(toManifest),

  *execute(call: ToolCall, context: AgentToolContext): Operation<ToolOutcome> {
    const tool = findTool(call.toolName);
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
  },

  *complete(
    call: ToolCall,
    context: AgentToolContext,
  ): Operation<PendingEvent> {
    const tool = findTool(call.toolName);
    if (!tool) {
      return {
        call,
        outcome: {status: "failed", error: `unknown tool: ${call.toolName}`},
      };
    }
    try {
      return {
        call,
        outcome: yield* tool.complete(call.input, {
          ...context,
          toolCallId: call.toolCallId,
        }),
      };
    } catch (error) {
      if (
        error instanceof InterruptedError ||
        error instanceof CancelledError
      ) {
        throw error;
      }
      return {
        call,
        outcome: {
          status: "failed",
          error: `${call.toolName} failed while pending: ${errorMessage(error)}`,
        },
      };
    }
  },

  toModelMessage,
  toRuntimeMessage,
};
