// The built-in tool registry and dispatcher. Tool definitions live in
// `tools/`, grouped by what they touch; this module resolves a model call to
// a built-in, dynamic (Restate handler) or MCP tool, and converts outcomes
// into model and transcript messages.

import type {AgentTools, ConversationEntry} from "@restate-agents/types";
import type * as restate from "@restatedev/restate-sdk-gen";
import type {JSONValue, ModelMessage, ToolModelMessage} from "ai";
import {z} from "zod";

import {errorMessage, isCancellation} from "../errors.js";
import type {ToolCall, ToolManifest} from "../model/index.js";
import {PROGRAM_TOOL_NAME, programToolManifest} from "../ptc/definition.js";
import {openTurnSandbox} from "../sandbox/index.js";
import {type DiscoveredAgentTool, executeDynamicTool} from "./dynamic-tools.js";
import {executeMcpTool, type McpAgentTool} from "./mcp-tools.js";
import {executeProgramTool} from "./program-tool.js";
import {toolAllowed} from "./tool-permissions.js";
import {createToolSearch, TOOL_SEARCH_NAME} from "./tool-search.js";
import * as state from "./tools/agent-state.js";
import {humanApprovalTool} from "./tools/approval.js";
import {
  type AgentTool,
  type AgentToolContext,
  failed,
  type PendingEvent,
  type ToolExecutionScope,
  type ToolOutcome,
} from "./tools/define.js";
import * as local from "./tools/local.js";
import * as sandbox from "./tools/sandbox.js";
import * as subAgents from "./tools/sub-agents.js";

export type {
  AgentToolContext,
  PendingEvent,
  ToolExecutionScope,
  ToolOutcome,
} from "./tools/define.js";

const definitions: readonly AgentTool[] = [
  local.searchToolsTool,
  local.getWeatherTool,
  local.webSearchTool,
  local.sleepTool,
  humanApprovalTool,
  local.cancelOperationTool,
  state.manageMemoryTool,
  subAgents.createSubAgentTool,
  subAgents.messageSubAgentTool,
  subAgents.deleteSubAgentTool,
  subAgents.listSubAgentsTool,
  state.createScheduleTool,
  state.cancelScheduleTool,
  state.listSchedulesTool,
  sandbox.listFilesTool,
  sandbox.readFileTool,
  sandbox.writeFileTool,
  sandbox.executeCommandTool,
];

/** Names reserved by built-in tools and unavailable to dynamic discovery. */
export const names = [PROGRAM_TOOL_NAME, ...definitions.map(({name}) => name)];

/** Every built-in tool, as the tool-permission UI lists them. */
export const builtinCatalog = [programToolManifest, ...definitions].map(
  ({name, description}) => ({name, description}),
);

/**
 * Creates the tool context. The turn's sandbox is acquired lazily, once, by
 * the first sandbox tool; parallel tools and later steps reuse it.
 */
export function createAgentToolContext(
  agentId: string,
  turnId: string,
  webSearchEnabled: boolean,
  permissions: AgentTools,
): AgentToolContext {
  return {
    agentId,
    turnId,
    webSearchEnabled,
    permissions,
    sandbox: openTurnSandbox(agentId),
  };
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

/** Complete permitted runtime catalog, including tools not yet shown to the model. */
export function manifests(
  discovered: DiscoveredAgentTool[],
  mcpTools: McpAgentTool[],
  context: Pick<AgentToolContext, "webSearchEnabled" | "permissions">,
): ToolManifest[] {
  return [
    programToolManifest,
    ...definitions
      .filter((tool) => tool.name !== "webSearch" || context.webSearchEnabled)
      .map((tool): ToolManifest => ({
        name: tool.name,
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.inputSchema, {target: "draft-7"}),
        strict: true,
      })),
    ...discovered.map((tool): ToolManifest => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      // Third-party JSON Schema is not guaranteed to satisfy OpenAI's
      // requirement that every object property appear in `required`.
      strict: false,
    })),
    ...mcpTools.map((tool): ToolManifest => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      strict: false,
    })),
  ].filter((tool) =>
    toolAllowed(tool.name, context.permissions, discovered, mcpTools, names),
  );
}

/** Returns the concise user-facing activity label for a tool call. */
export function summarize(call: ToolCall): string | undefined {
  if (call.toolName === PROGRAM_TOOL_NAME)
    return "Coordinated tools with JavaScript";
  return findTool(call.toolName)?.summarize(call.input);
}

function turnToolSearch(
  context: AgentToolContext,
  discovered: DiscoveredAgentTool[],
  mcpTools: McpAgentTool[],
) {
  context.toolSearch ??= createToolSearch(
    manifests(discovered, mcpTools, context),
    new Map([
      ...discovered.map(
        (tool) =>
          [tool.name, `${tool.target.service} ${tool.target.handler}`] as const,
      ),
      ...mcpTools.map(
        (tool) =>
          [
            tool.name,
            `${tool.target.server.id} ${tool.target.remoteName}`,
          ] as const,
      ),
    ]),
  );
  return context.toolSearch;
}

/** Model context is built-ins plus tools selected by searches in this turn. */
export function modelManifests(
  discovered: DiscoveredAgentTool[],
  mcpTools: McpAgentTool[],
  context: AgentToolContext,
): ToolManifest[] {
  const catalog = manifests(discovered, mcpTools, context);
  // Explicitly disabling search must not strand an agent's other tool grants.
  if (!catalog.some((tool) => tool.name === TOOL_SEARCH_NAME)) return catalog;
  const search = turnToolSearch(context, discovered, mcpTools);
  return catalog.filter(
    (tool) => names.includes(tool.name) || search.loaded.has(tool.name),
  );
}

/** Executes a static or dynamically discovered tool inside the active step. */
export function* execute(
  call: ToolCall,
  context: AgentToolContext,
  discovered: DiscoveredAgentTool[],
  mcpTools: McpAgentTool[],
  scope?: ToolExecutionScope,
): restate.Operation<ToolOutcome> {
  if (
    !toolAllowed(
      call.toolName,
      context.permissions,
      discovered,
      mcpTools,
      names,
    )
  )
    return {call, ...failed("This tool is not enabled for this agent.")};
  if (call.toolName === "webSearch" && !context.webSearchEnabled)
    return {call, ...failed("Web search is disabled for this turn.")};
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
    if (call.toolName === TOOL_SEARCH_NAME)
      turnToolSearch(context, discovered, mcpTools);
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
  if (!dynamic && !mcp)
    return {call, ...failed(`unknown tool: ${call.toolName}`)};
  if (
    typeof call.input !== "object" ||
    call.input === null ||
    Array.isArray(call.input)
  )
    return {call, ...failed("external tool input must be an object")};
  const fields = call.input as Record<string, unknown>;
  return {
    call,
    ...(mcp
      ? yield* executeMcpTool(
          fields,
          {turnId: context.turnId, toolCallId: call.toolCallId},
          mcp,
        )
      : yield* executeDynamicTool(fields, dynamic!)),
  };
}

/** Waits for a concrete pending tool to complete after its originating step. */
export function* complete(
  call: ToolCall,
  context: AgentToolContext,
  step: number,
): restate.Operation<PendingEvent> {
  const tool = findTool(call.toolName);
  if (!tool)
    return {step, call, outcome: failed(`unknown tool: ${call.toolName}`)};
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
    if (isCancellation(error)) throw error;
    return {
      step,
      call,
      outcome: failed(
        `${call.toolName} failed while pending: ${errorMessage(error)}`,
      ),
    };
  }
}

function findTool(name: string): AgentTool | undefined {
  return definitions.find((candidate) => candidate.name === name);
}
