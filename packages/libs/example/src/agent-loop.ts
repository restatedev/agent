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
  race,
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
  | {status: "pending"; result: Record<string, unknown>}
  | {status: "cancel_requested"; operationId: string; reason: string};

type ToolCompletion =
  | Extract<ToolExecution, {status: "succeeded" | "failed"}>
  | {status: "cancelled"; reason: string};

type ToolOutcome = ToolExecution & {call: ToolCall};

type PendingEvent = {
  call: ToolCall;
  outcome: ToolCompletion;
};

type PendingOperation = {
  call: ToolCall;
  task: Task<PendingEvent>;
};

type ModelStep = {
  action: ModelResult;
  steering: string[];
  nextSteering: Future<string>;
};

type ToolStep = {
  outcomes: ToolOutcome[];
  pending: PendingOperation[];
  steering: string[];
  nextSteering: Future<string>;
};

type CancellationStep = {
  outcomes: ToolOutcome[];
  pending: PendingOperation[];
  events: PendingEvent[];
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
  complete(
    input: unknown,
    context: AgentToolContext,
  ): Operation<ToolCompletion>;
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
  complete?(
    input: z.output<Schema>,
    context: AgentToolContext,
  ): Operation<ToolCompletion>;
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
    *complete(
      input: unknown,
      context: AgentToolContext,
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
        error: `getWeather failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
});

const sleepTool = defineAgentTool({
  name: "sleep",
  description:
    "Start a durable timer. The timer remains active across later model rounds, and the turn cannot finish until it completes.",
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
    "Request human approval for a proposed action. The request remains pending across later model rounds. Call it by itself and do not perform dependent actions until a runtime update reports approval.",
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

const STATIC_TOOLS = [
  getWeatherTool,
  sleepTool,
  humanApprovalTool,
  cancelOperationTool,
] as const;

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

function* completeTool(
  tool: AgentTool,
  call: ToolCall,
  context: Omit<AgentToolContext, "toolCallId">,
): Operation<PendingEvent> {
  try {
    return {
      call,
      outcome: yield* tool.complete(call.input, {
        ...context,
        toolCallId: call.toolCallId,
      }),
    };
  } catch (error) {
    if (error instanceof InterruptedError || error instanceof CancelledError) {
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

function toPendingMessage({call, outcome}: PendingEvent): ModelMessage {
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

// Cancellation is a model decision, but the loop owns the live task registry.
// Resolve each declarative request here, after preserving the model's complete
// tool-call/result protocol. A completion that wins the race is reported as
// completed rather than being rewritten as cancelled.
function* applyCancellations(
  outcomes: ToolOutcome[],
  pending: PendingOperation[],
): Operation<CancellationStep> {
  const resolved: ToolOutcome[] = [];
  const events: PendingEvent[] = [];
  let remaining = pending;

  for (const outcome of outcomes) {
    if (outcome.status !== "cancel_requested") {
      resolved.push(outcome);
      continue;
    }

    const operation = remaining.find(
      ({call}) => call.toolCallId === outcome.operationId,
    );
    if (!operation) {
      resolved.push({
        call: outcome.call,
        status: "failed",
        error: `no pending operation found for ${outcome.operationId}`,
      });
      continue;
    }

    operation.task.interrupt(new InterruptedError(outcome.reason));
    const [settled] = yield* allSettled([operation.task]);
    remaining = remaining.filter(
      ({call}) => call.toolCallId !== operation.call.toolCallId,
    );

    if (settled.status === "fulfilled") {
      events.push(settled.value);
      resolved.push({
        call: outcome.call,
        status: "failed",
        error: `${outcome.operationId} completed before it could be cancelled`,
      });
      continue;
    }

    events.push({
      call: operation.call,
      outcome: {status: "cancelled", reason: outcome.reason},
    });
    resolved.push({
      call: outcome.call,
      status: "succeeded",
      result: `Cancelled pending ${operation.call.toolName} operation ${outcome.operationId}`,
    });
  }

  return {outcomes: resolved, pending: remaining, events};
}

// Steering is buffered while a model call is in flight. The completed model
// action remains the current round; buffered instructions apply afterward.
function* runModelStep(
  agentId: string,
  messages: ModelMessage[],
  manifests: ToolManifest[],
  steering: Future<string>,
): Operation<ModelStep> {
  const modelTask = spawn(callModel(agentId, messages, manifests));
  const buffered: string[] = [];
  let nextSteering = steering;
  while (true) {
    const selected = yield* select({
      steering: nextSteering,
      model: modelTask,
    });
    if (selected.tag === "model") {
      return {
        action: yield* selected.future,
        steering: buffered,
        nextSteering,
      };
    }
    buffered.push(yield* selected.future);
    nextSteering = signal<string>(STEERING);
  }
}

// Foreground calls finish as one protocol-complete batch. Steering received
// meanwhile is buffered, and pending calls start turn-scoped completion tasks.
function* runToolStep(
  tools: readonly AgentTool[],
  calls: ToolCall[],
  context: Omit<AgentToolContext, "toolCallId">,
  steering: Future<string>,
): Operation<ToolStep> {
  const tasks = calls.map((call) => spawn(executeTool(tools, call, context)));
  const completed = all(tasks);
  const buffered: string[] = [];
  let nextSteering = steering;

  while (true) {
    const selected = yield* select({
      steering: nextSteering,
      tools: completed,
    });
    if (selected.tag === "steering") {
      buffered.push(yield* selected.future);
      nextSteering = signal<string>(STEERING);
      continue;
    }

    const outcomes = yield* selected.future;
    const pending = outcomes.flatMap((outcome): PendingOperation[] => {
      if (outcome.status !== "pending") {
        return [];
      }
      const tool = tools.find(
        (candidate) => candidate.name === outcome.call.toolName,
      );
      if (!tool) {
        return [];
      }
      return [
        {
          call: outcome.call,
          task: spawn(completeTool(tool, outcome.call, context)),
        },
      ];
    });
    return {
      outcomes,
      pending,
      steering: buffered,
      nextSteering,
    };
  }
}

function* stopPendingOperations(
  pending: PendingOperation[],
  reason: unknown,
): Operation<void> {
  for (const operation of pending) {
    operation.task.interrupt(reason);
  }
  yield* allSettled(pending.map(({task}) => task));
}

function* waitForPendingOperation(
  pending: PendingOperation[],
  steering: Future<string>,
): Operation<
  | {type: "steering"; message: string; nextSteering: Future<string>}
  | {type: "completion"; event: PendingEvent}
> {
  const selected = yield* select({
    steering,
    completion: race(pending.map(({task}) => task)),
  });
  if (selected.tag === "steering") {
    return {
      type: "steering",
      message: yield* selected.future,
      nextSteering: signal<string>(STEERING),
    };
  }
  return {type: "completion", event: yield* selected.future};
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
  let pending: PendingOperation[] = [];

  try {
    while (modelRounds < MAX_ROUNDS) {
      const step = yield* runModelStep(agentId, messages, manifests, steering);
      steering = step.nextSteering;
      consumedSteering += step.steering.length;
      const {action} = step;
      modelRounds += 1;

      // A text/error response was produced before these instructions arrived.
      // It has no side effects, so apply the buffered steering instead of
      // exposing a stale answer or retrying a stale model error.
      if (action.type !== "tool_calls" && step.steering.length > 0) {
        messages.push(
          ...step.steering.map(
            (content): ModelMessage => ({
              role: "user",
              content,
            }),
          ),
        );
        continue;
      }

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
        if (pending.length > 0) {
          const next = yield* waitForPendingOperation(pending, steering);
          if (next.type === "steering") {
            consumedSteering += 1;
            steering = next.nextSteering;
            messages.push({role: "user", content: next.message});
          } else {
            pending = pending.filter(
              ({call}) => call.toolCallId !== next.event.call.toolCallId,
            );
            messages.push(toPendingMessage(next.event));
          }
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
        yield* stopPendingOperations(
          pending,
          new InterruptedError("agent exceeded its tool-call budget"),
        );
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
      steering = toolStep.nextSteering;
      consumedSteering += toolStep.steering.length;
      const cancellationStep = yield* applyCancellations(
        toolStep.outcomes,
        pending,
      );
      messages.push(toToolMessage(cancellationStep.outcomes));
      pending = [...cancellationStep.pending, ...toolStep.pending];
      messages.push(...cancellationStep.events.map(toPendingMessage));

      messages.push(
        ...[...step.steering, ...toolStep.steering].map(
          (content): ModelMessage => ({role: "user", content}),
        ),
      );
    }

    yield* stopPendingOperations(
      pending,
      new InterruptedError("agent exceeded its model-round budget"),
    );
    return {
      status: "failed",
      error: `agent did not finish within ${MAX_ROUNDS} rounds`,
      consumedSteering,
    };
  } catch (error) {
    if (error instanceof InterruptedError || error instanceof CancelledError) {
      yield* stopPendingOperations(pending, error);
      throw error;
    }
    yield* stopPendingOperations(pending, error);
    return {
      status: "failed",
      error: errorMessage(error),
      consumedSteering,
    };
  }
}
