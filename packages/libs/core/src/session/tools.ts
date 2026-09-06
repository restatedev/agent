// Concrete tools available to the example agent. Each definition owns its
// model description, input schema, validation, and local durable behavior.
// The exported object is deliberately concrete rather than a generic runtime:
// AgentSession owns orchestration, step.ts owns foreground execution, and this
// module owns tool mechanics.

import {setTimeout} from "node:timers/promises";
import {
  type ApprovalDecision,
  type ConversationEntry,
  type McpServer,
  type MemoryChange,
  ScheduleIdRequestSchema,
  ScheduleSpecSchema,
} from "@restate-agents/types";
import {AgentSchedulerDefinition} from "@restate-agents/types/services";
import {CancelledError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import type {JSONValue, ModelMessage, ToolModelMessage} from "ai";
import {z} from "zod";
import {Agent} from "../agent/index.js";
import type {ToolCall, ToolManifest} from "../gateway/index.js";
import {approvalSignalName} from "../internal-types.js";
import {PROGRAM_TOOL_NAME, programToolManifest} from "../ptc/definition.js";
import {
  Sandbox,
  type SandboxClient,
  type SandboxRef,
  sandboxProvider,
} from "../sandbox/index.js";
import type {DiscoveredAgentTool} from "./dynamic-tools.js";
import type {TurnHistory} from "./history.js";
import {
  executeMcpTool,
  type McpAgentTool,
  type McpAuthChallenge,
  type McpAuthorizationGrant,
  requestMcpAuthorization,
} from "./mcp-tools.js";
import {executeProgramTool} from "./program-tool.js";

type ToolTranscript = {transcript?: ConversationEntry[]};

type ToolExecution = (
  | {status: "succeeded"; result: string}
  | {status: "failed"; error: string}
  | {status: "pending"; result: Record<string, unknown>}
  | {status: "cancel_requested"; operationId: string; reason: string}
) &
  ToolTranscript;

type ToolCompletion = (
  | Extract<ToolExecution, {status: "succeeded" | "failed"}>
  | {status: "cancelled"; reason: string}
) &
  ToolTranscript;

/** Initial result of invoking one model-selected tool. */
export type ToolOutcome = ToolExecution & {call: ToolCall};

/** Completion emitted later by a tool that initially returned pending. */
export type PendingEvent = {
  step: number;
  call: ToolCall;
  outcome: ToolCompletion;
};

/** Agent- and Turn-scoped capabilities passed to concrete tool definitions. */
export type AgentToolContext = {
  agentId: string;
  turnId: string;
  sandbox: {
    client(): restate.Operation<SandboxClient>;
  };
  mcpAuthorization: {
    authorize(
      serverId: string,
      authType: Exclude<McpServer["auth"]["type"], "none">,
      causeId: string,
      challenge: McpAuthChallenge,
    ): restate.Operation<McpAuthorizationGrant>;
  };
};

/** Step-owned policy and lifecycle hooks used by PTC's concrete child calls. */
export type ToolExecutionScope = {
  transcript: TurnHistory;
  step: number;
  guard(call: ToolCall): restate.Operation<string | undefined>;
  cancelPending(outcome: ToolOutcome): restate.Operation<ToolOutcome>;
};

type ToolCallContext = AgentToolContext & {
  toolCallId: string;
};

type AgentTool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  summarize(input: unknown): string | undefined;
  execute(
    input: unknown,
    context: ToolCallContext,
  ): restate.Operation<ToolExecution>;
  complete(
    input: unknown,
    context: ToolCallContext,
  ): restate.Operation<ToolCompletion>;
};

/**
 * Creates the tool context and lazily borrows the Agent-owned sandbox once.
 * Parallel tools share the same in-flight borrow and later steps reuse it.
 */
export function createAgentToolContext(
  agentId: string,
  turnId: string,
): AgentToolContext {
  let borrow: restate.Future<SandboxRef> | undefined;
  let ref: SandboxRef | undefined;
  const authorizations = new Map<string, restate.Task<McpAuthorizationGrant>>();
  return {
    agentId,
    turnId,
    sandbox: {
      *client(): restate.Operation<SandboxClient> {
        borrow ??= restate.client(Sandbox, agentId).borrow({turnId});
        ref ??= yield* borrow;
        return sandboxProvider.connect(ref);
      },
    },
    mcpAuthorization: {
      *authorize(
        serverId: string,
        authType: Exclude<McpServer["auth"]["type"], "none">,
        causeId: string,
        challenge: McpAuthChallenge,
      ): restate.Operation<McpAuthorizationGrant> {
        let task = authorizations.get(serverId);
        if (!task) {
          task = restate.spawn(
            requestMcpAuthorizationGrant(
              serverId,
              {agentId, turnId},
              authType,
              causeId,
              challenge,
            ),
          );
          authorizations.set(serverId, task);
        }
        try {
          return yield* task;
        } finally {
          if (authorizations.get(serverId) === task) {
            authorizations.delete(serverId);
          }
        }
      },
    },
  };
}

function* requestMcpAuthorizationGrant(
  serverId: string,
  context: {agentId: string; turnId: string},
  authType: Exclude<McpServer["auth"]["type"], "none">,
  causeId: string,
  challenge: McpAuthChallenge,
): restate.Operation<McpAuthorizationGrant> {
  const credential = yield* requestMcpAuthorization(
    serverId,
    context,
    authType,
    causeId,
    challenge,
  );
  return {credential, challenge};
}

/** Converts one foreground tool batch into the model's tool-result message. */
export function toModelMessage(outcomes: ToolOutcome[]): ToolModelMessage {
  return {
    role: "tool",
    content: outcomes.map((outcome): ToolModelMessage["content"][number] => {
      let value: JSONValue;
      switch (outcome.status) {
        case "succeeded":
          value = {ok: true, result: outcome.result};
          break;
        case "failed":
          value = {ok: false, error: outcome.error};
          break;
        case "pending":
          value = {ok: true, pending: true, ...outcome.result};
          break;
        case "cancel_requested":
          value = {
            ok: false,
            error: `cancellation request for ${outcome.operationId} was not applied`,
          };
          break;
      }
      return {
        type: "tool-result",
        toolCallId: outcome.call.toolCallId,
        toolName: outcome.call.toolName,
        output: {type: "json", value},
      };
    }),
  };
}

/** Converts a pending completion into an explicit runtime message for the model. */
export function toRuntimeMessage({call, outcome}: PendingEvent): ModelMessage {
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

/** Projects tool-specific lifecycle effects into the durable transcript. */
export function transcriptEntries(
  event: ToolOutcome | PendingEvent,
  context: AgentToolContext,
  interruptedPendingReason?: string,
): ConversationEntry[] {
  const pendingEvent = "outcome" in event;
  const result = pendingEvent ? event.outcome : event;
  const entries = [...(result.transcript ?? [])];
  const cancelledApproval =
    event.call.toolName === "humanApproval" &&
    ((pendingEvent && result.status === "cancelled") ||
      (!pendingEvent &&
        result.status === "pending" &&
        interruptedPendingReason !== undefined));
  if (cancelledApproval) {
    entries.push({
      role: "event",
      type: "approval_cancelled",
      approvalId: event.call.toolCallId,
      turnId: context.turnId,
    });
  }
  return entries;
}

/** Builds the complete static and dynamically discovered model tool catalog. */
export function manifests(
  discovered: DiscoveredAgentTool[],
  mcpTools: McpAgentTool[],
): ToolManifest[] {
  return [
    programToolManifest,
    ...definitions.map(
      (tool): ToolManifest => ({
        name: tool.name,
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.inputSchema, {target: "draft-7"}),
        strict: true,
      }),
    ),
    ...discovered.map(
      (tool): ToolManifest => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // Third-party JSON Schema is not guaranteed to satisfy OpenAI's
        // requirement that every object property appear in `required`.
        strict: false,
      }),
    ),
    ...mcpTools.map(
      (tool): ToolManifest => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        strict: false,
      }),
    ),
  ];
}

/** Returns the concise user-facing activity label for a tool call. */
export function summarize(call: ToolCall): string | undefined {
  if (call.toolName === PROGRAM_TOOL_NAME)
    return "Coordinated tools with JavaScript";
  return findTool(call.toolName)?.summarize(call.input);
}

/** Executes a static or dynamically discovered tool inside the active step. */
export function* execute(
  call: ToolCall,
  context: AgentToolContext,
  discovered: DiscoveredAgentTool[],
  mcpTools: McpAgentTool[],
  scope?: ToolExecutionScope,
): restate.Operation<ToolOutcome> {
  if (call.toolName === PROGRAM_TOOL_NAME) {
    if (!scope) throw new Error("PTC requires an active tool execution scope");
    return yield* executeProgramTool(
      call,
      context,
      discovered,
      mcpTools,
      scope,
    );
  }
  const tool = findTool(call.toolName);
  if (tool) {
    return {
      call,
      ...(yield* tool.execute(call.input, {
        ...context,
        toolCallId: call.toolCallId,
      })),
    };
  }

  const dynamic = discovered.find(({name}) => name === call.toolName);
  const mcp = mcpTools.find(({name}) => name === call.toolName);
  if (!dynamic && !mcp) {
    return {
      call,
      status: "failed",
      error: `unknown tool: ${call.toolName}`,
    };
  }
  if (
    typeof call.input !== "object" ||
    call.input === null ||
    Array.isArray(call.input)
  ) {
    return {
      call,
      status: "failed",
      error: "external tool input must be an object",
    };
  }
  const fields = call.input as Record<string, unknown>;
  if (mcp) {
    return {
      call,
      ...(yield* executeMcpTool(
        fields,
        {
          turnId: context.turnId,
          toolCallId: call.toolCallId,
          authorize: context.mcpAuthorization.authorize,
        },
        mcp,
      )),
    };
  }

  // The lookup above establishes that one backend exists. This assertion keeps
  // the backend-specific path explicit without merging MCP and Restate inputs.
  if (!dynamic) {
    throw new Error(`missing external tool backend for ${call.toolName}`);
  }
  let key: string | undefined;
  if (dynamic.target.keyed) {
    if (typeof fields.key !== "string" || fields.key.length === 0) {
      return {
        call,
        status: "failed",
        error: "dynamic Virtual Object and Workflow tools require a key",
      };
    }
    key = fields.key;
  }
  if (dynamic.target.acceptsInput && !("input" in fields)) {
    return {
      call,
      status: "failed",
      error: "dynamic tool input is missing input",
    };
  }

  try {
    const result = yield* restate.call<unknown, unknown>({
      service: dynamic.target.service,
      method: dynamic.target.handler,
      ...(key === undefined ? {} : {key}),
      parameter: dynamic.target.acceptsInput ? fields.input : undefined,
      inputSerde: restate.serde.json,
      outputSerde: restate.serde.json,
      name: `dynamic-tool-${dynamic.name}`,
    });
    return {
      call,
      status: "succeeded",
      result:
        typeof result === "string"
          ? result
          : (JSON.stringify(result) ?? "Handler completed without a result"),
    };
  } catch (error) {
    if (
      error instanceof restate.InterruptedError ||
      error instanceof CancelledError
    ) {
      throw error;
    }
    return {
      call,
      status: "failed",
      error: `${dynamic.name} failed: ${errorMessage(error)}`,
    };
  }
}

/** Waits for a concrete pending tool to complete after its originating step. */
export function* complete(
  call: ToolCall,
  context: AgentToolContext,
  step: number,
): restate.Operation<PendingEvent> {
  const tool = findTool(call.toolName);
  if (!tool) {
    return {
      step,
      call,
      outcome: {status: "failed", error: `unknown tool: ${call.toolName}`},
    };
  }
  try {
    return {
      step,
      call,
      outcome: yield* tool.complete(call.input, {
        ...context,
        toolCallId: call.toolCallId,
      }),
    };
  } catch (error) {
    if (
      error instanceof restate.InterruptedError ||
      error instanceof CancelledError
    ) {
      throw error;
    }
    return {
      step,
      call,
      outcome: {
        status: "failed",
        error: `${call.toolName} failed while pending: ${errorMessage(error)}`,
      },
    };
  }
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
  *run({city}): restate.Operation<ToolExecution> {
    try {
      const weather = yield* restate.run(
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
      if (
        error instanceof restate.InterruptedError ||
        error instanceof CancelledError
      ) {
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
  *run({durationSeconds}, context): restate.Operation<ToolExecution> {
    return {
      status: "pending",
      result: {
        operationId: context.toolCallId,
        status: "running",
        durationSeconds,
      },
    };
  },
  *complete({durationSeconds}, context): restate.Operation<ToolCompletion> {
    yield* restate.sleep(
      durationSeconds * 1_000,
      `sleep-${context.toolCallId}`,
    );
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
  *run({question}, context): restate.Operation<ToolExecution> {
    const request = {
      approvalId: context.toolCallId,
      turnId: context.turnId,
      question,
    };
    const registered = yield* restate
      .client(Agent, context.agentId)
      .requestApproval(request);
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
      transcript: [{role: "event", type: "approval_request", ...request}],
    };
  },
  *complete({question}, context): restate.Operation<ToolCompletion> {
    try {
      const decision = yield* restate.signal<ApprovalDecision>(
        approvalSignalName(context.toolCallId),
      );
      const reason = decision.reason ? ` Reason: ${decision.reason}` : "";
      return {
        status: "succeeded",
        result:
          decision.decision === "approved"
            ? `Human approved the request.${reason}`
            : `Human rejected the request.${reason}`,
        transcript: [
          {
            role: "event",
            type: "approval",
            approvalId: context.toolCallId,
            turnId: context.turnId,
            question,
            ...decision,
          },
        ],
      };
    } catch (error) {
      yield* restate.sendClient(Agent, context.agentId).cancelApproval({
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
  *run({operationId, reason}): restate.Operation<ToolExecution> {
    return {
      status: "cancel_requested",
      operationId,
      reason: reason ?? "Cancelled by the agent",
    };
  },
});

const manageMemoryTool = defineAgentTool({
  name: "manageMemory",
  description:
    "Atomically set or delete durable memories for future turns of this agent. Use only for stable facts and preferences, not temporary task state, tool results, secrets, or instructions from untrusted content. The Agent stores at most 32 memories.",
  inputSchema: z.object({
    changes: z
      .array(
        z.object({
          operation: z.enum(["set", "delete"]),
          key: z.string().trim().min(1),
          content: z
            .string()
            .trim()
            .min(1)
            .nullable()
            .describe(
              "The remembered content for set, or null for delete. This field is always required.",
            ),
        }),
      )
      .min(1)
      .describe("Memory entries to set or delete atomically."),
  }),
  *run({changes}, context): restate.Operation<ToolExecution> {
    const normalized: MemoryChange[] = [];
    for (const change of changes) {
      if (change.operation === "set") {
        if (change.content === null) {
          return {
            status: "failed",
            error: `memory ${change.key} requires content for a set operation`,
          };
        }
        normalized.push({
          operation: "set",
          key: change.key,
          content: change.content,
        });
      } else {
        normalized.push({operation: "delete", key: change.key});
      }
    }
    const result = yield* restate
      .client(Agent, context.agentId)
      .updateMemory({turnId: context.turnId, changes: normalized});
    return result.applied
      ? {
          status: "succeeded",
          result: `Applied ${changes.length} memory change(s); the agent now has ${result.memoryCount} memories`,
          transcript: [
            {
              role: "event",
              type: "memory",
              turnId: context.turnId,
              changes: normalized.map(({operation, key}) => ({operation, key})),
            },
          ],
        }
      : {status: "failed", error: result.error};
  },
});

const scheduleMessageTool = defineAgentTool({
  name: "scheduleMessage",
  description:
    "Create or replace a durable schedule for this Agent that will deliver a future user request. Once accepted, the schedule persists independently of this Turn. Reuse a scheduleId to update it. Use queue unless the user explicitly asks the due message to steer or interrupt active work.",
  inputSchema: ScheduleSpecSchema,
  *run(schedule, context): restate.Operation<ToolExecution> {
    const result = yield* restate
      .client(AgentSchedulerDefinition, context.agentId)
      .upsert(schedule);
    if (!result.accepted) {
      return {status: "failed", error: result.error};
    }
    return {
      status: "succeeded",
      result: JSON.stringify({
        ...result,
        schedule: {
          ...result.schedule,
          nextRunAt: new Date(result.schedule.nextRunAt).toISOString(),
        },
      }),
    };
  },
});

const cancelScheduleTool = defineAgentTool({
  name: "cancelSchedule",
  description:
    "Cancel one durable message scheduled for this Agent by its scheduleId. This is idempotent; cancelling an unknown schedule succeeds without changing anything.",
  inputSchema: ScheduleIdRequestSchema,
  *run({scheduleId}, context): restate.Operation<ToolExecution> {
    const result = yield* restate
      .client(AgentSchedulerDefinition, context.agentId)
      .cancel({scheduleId});
    if (!result.accepted) {
      return {status: "failed", error: result.error};
    }
    return {
      status: "succeeded",
      result: result.cancelled
        ? `Cancelled schedule ${scheduleId}`
        : `Schedule ${scheduleId} was not active`,
    };
  },
});

const listSchedulesTool = defineAgentTool({
  name: "listSchedules",
  description:
    "List the Agent's active scheduled messages, including their next delivery time, recurrence, and busy-turn policy.",
  inputSchema: z.object({}),
  *run(_input, context): restate.Operation<ToolExecution> {
    const active = yield* restate
      .client(AgentSchedulerDefinition, context.agentId)
      .list();
    return {
      status: "succeeded",
      result: JSON.stringify(
        active.map((schedule) => ({
          ...schedule,
          nextRunAt: new Date(schedule.nextRunAt).toISOString(),
        })),
      ),
    };
  },
});

const listFilesTool = defineAgentTool({
  name: "listFiles",
  description:
    "List files at one path in the agent's persistent sandbox. Use '.' for the working directory.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Directory path to list."),
  }),
  summarize: ({path}) => `Listed files in ${path}`,
  *run({path}, context): restate.Operation<ToolExecution> {
    return yield* runSandboxTool(
      `Listed files in ${path}`,
      context,
      async (client, signal) =>
        JSON.stringify(await client.listFiles(path, {signal})),
    );
  },
});

const readFileTool = defineAgentTool({
  name: "readFile",
  description: "Read one UTF-8 text file from the agent's persistent sandbox.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Path of the text file to read."),
  }),
  summarize: ({path}) => `Read ${path}`,
  *run({path}, context): restate.Operation<ToolExecution> {
    return yield* runSandboxTool(
      `Read ${path}`,
      context,
      async (client, signal) => client.readFile(path, {signal}),
    );
  },
});

const writeFileTool = defineAgentTool({
  name: "writeFile",
  description:
    "Write one complete UTF-8 text file in the agent's persistent sandbox, replacing its previous contents.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Path of the text file to write."),
    content: z.string().describe("Complete new contents of the file."),
  }),
  summarize: ({path}) => `Wrote ${path}`,
  *run({path, content}, context): restate.Operation<ToolExecution> {
    return yield* runSandboxTool(
      `Wrote ${path}`,
      context,
      async (client, signal) => {
        await client.writeFile(path, content, {signal});
        return `Wrote ${Buffer.byteLength(content)} bytes to ${path}`;
      },
    );
  },
});

const executeCommandTool = defineAgentTool({
  name: "executeCommand",
  description:
    "Execute one shell command in the agent's persistent sandbox and wait for its final exit result. This tool never becomes a pending agent operation. To intentionally leave work running, launch and track a background shell script from the command itself.",
  inputSchema: z.object({
    command: z.string().min(1).describe("Shell command to execute."),
    cwd: z
      .string()
      .min(1)
      .nullable()
      .describe("Working directory, or null for the sandbox default."),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(3_600)
      .nullable()
      .describe(
        "Command timeout in seconds, or null for the provider default.",
      ),
  }),
  summarize: () => "Ran command",
  *run(
    {command, cwd, timeoutSeconds},
    context,
  ): restate.Operation<ToolExecution> {
    return yield* runSandboxTool(
      "Ran command",
      context,
      async (client, signal) => {
        const result = await client.executeCommand(
          {
            command,
            cwd: cwd ?? undefined,
            timeoutMs:
              timeoutSeconds === null ? undefined : timeoutSeconds * 1_000,
          },
          {signal},
        );
        return JSON.stringify(result);
      },
    );
  },
});

const definitions = [
  getWeatherTool,
  sleepTool,
  humanApprovalTool,
  cancelOperationTool,
  manageMemoryTool,
  scheduleMessageTool,
  cancelScheduleTool,
  listSchedulesTool,
  listFilesTool,
  readFileTool,
  writeFileTool,
  executeCommandTool,
] as const;

/** Names reserved by built-in tools and unavailable to dynamic discovery. */
export const names = [PROGRAM_TOOL_NAME, ...definitions.map(({name}) => name)];

// The schema type parameter exists only to type `run`/`complete` inputs from
// `inputSchema`; callers see a plain AgentTool.
function defineAgentTool<Schema extends z.ZodType>(definition: {
  name: string;
  description: string;
  inputSchema: Schema;
  summarize?(input: z.output<Schema>): string;
  run(
    input: z.output<Schema>,
    context: ToolCallContext,
  ): restate.Operation<ToolExecution>;
  complete?(
    input: z.output<Schema>,
    context: ToolCallContext,
  ): restate.Operation<ToolCompletion>;
}): AgentTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    summarize(input: unknown): string | undefined {
      if (!definition.summarize) {
        return undefined;
      }
      const parsed = definition.inputSchema.safeParse(input);
      return parsed.success ? definition.summarize(parsed.data) : undefined;
    },
    *execute(
      input: unknown,
      context: ToolCallContext,
    ): restate.Operation<ToolExecution> {
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
    ): restate.Operation<ToolCompletion> {
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

function findTool(name: string): AgentTool | undefined {
  return definitions.find((candidate) => candidate.name === name);
}

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

function* runSandboxTool(
  name: string,
  context: ToolCallContext,
  operation: (client: SandboxClient, signal: AbortSignal) => Promise<string>,
): restate.Operation<ToolExecution> {
  try {
    const client = yield* context.sandbox.client();
    const result = yield* restate.run(({signal}) => operation(client, signal), {
      name,
    });
    return {status: "succeeded", result};
  } catch (error) {
    if (
      error instanceof restate.InterruptedError ||
      error instanceof CancelledError
    ) {
      throw error;
    }
    return {status: "failed", error: `${name} failed: ${errorMessage(error)}`};
  }
}
