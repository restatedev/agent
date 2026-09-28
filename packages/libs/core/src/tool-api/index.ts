// How to write a built-in tool: `defineAgentTool`, the context a tool body
// receives, and the result helpers every tool uses. The tools themselves live
// in `src/tools/`, and `src/agent-config.ts` chooses which ones the agent has.

import type {AgentTools, ConversationEntry} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import type {z} from "zod";

import {errorMessage, isCancellation, isRejection} from "../errors.js";
import type {TurnSandbox} from "../sandbox/index.js";
import type {TurnToolSearch} from "../session/tool-search.js";

type ToolTranscript = {transcript?: ConversationEntry[]};
type Succeeded = {status: "succeeded"; result: string};
type Failed = {status: "failed"; error: string};

/** A finished call: what dynamic and MCP tools, and foreground runs, return. */
export type ToolResult = Succeeded | Failed;

export type ToolExecution = (
  | Succeeded
  | Failed
  | {status: "pending"; result: Record<string, unknown>}
  | {status: "cancel_requested"; operationId: string; reason: string}
) &
  ToolTranscript;

/** How a tool that returned pending eventually ends. */
export type ToolCompletion = (
  | ToolResult
  | {status: "cancelled"; reason: string}
) &
  ToolTranscript;

/** Agent- and turn-scoped capabilities passed to tool definitions. */
export type AgentToolContext = {
  agentId: string;
  turnId: string;
  webSearchEnabled: boolean;
  permissions: AgentTools;
  toolSearch?: TurnToolSearch;
  sandbox: TurnSandbox;
};

export type ToolCallContext = AgentToolContext & {toolCallId: string};

/** What decides whether a tool is offered in a turn. */
export type ToolAvailabilityContext = Pick<
  AgentToolContext,
  "webSearchEnabled" | "permissions"
>;

export type AgentTool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  summary?: string;
  instructions?: string;
  unavailable?(context: ToolAvailabilityContext): string | undefined;
  execute(
    input: unknown,
    context: ToolCallContext,
  ): restate.Operation<ToolExecution>;
  complete(
    input: unknown,
    context: ToolCallContext,
  ): restate.Operation<ToolCompletion>;
};

export const succeeded = (result: string): Succeeded => ({
  status: "succeeded",
  result,
});
export const failed = (error: string): Failed => ({status: "failed", error});

/**
 * Reports an unexpected tool failure to the model as `<name> failed: …`.
 * Cancellation is rethrown.
 */
export function toolFailure(name: string, error: unknown): Failed {
  if (isCancellation(error)) throw error;
  return failed(`${name} failed: ${errorMessage(error)}`);
}

/** Runs one journaled side effect whose string result is the tool result. */
export function* toolRun(
  name: string,
  action: (context: {signal: AbortSignal}) => Promise<string>,
  retry?: restate.RetryOptions,
): restate.Operation<ToolExecution> {
  try {
    return succeeded(yield* restate.run(action, {name, retry}));
  } catch (error) {
    return toolFailure(name, error);
  }
}

/**
 * Runs a call into the Agent controller. Its rejections with `codes` are
 * feedback the model can act on; stale turns (409), cancellation and
 * infrastructure errors still escape.
 */
export function* agentCall<T>(
  codes: readonly number[],
  operation: () => restate.Operation<T>,
  prefix = "",
): restate.Operation<T | Failed> {
  try {
    return yield* operation();
  } catch (error) {
    if (isRejection(error, codes)) return failed(prefix + error.message);
    throw error;
  }
}

/** Link to an agent's conversation in the web app. */
export const agentUrl = (agentId: string) =>
  `/?agent=${encodeURIComponent(agentId)}`;

// The schema type parameter types `run`/`complete` inputs from `inputSchema`;
// callers see a plain AgentTool.
export function defineAgentTool<Schema extends z.ZodType>(definition: {
  name: string;
  description: string;
  inputSchema: Schema;
  /**
   * Fixed activity label for the public transcript, e.g. "Read a file".
   * Deliberately not a function of the input: raw tool arguments (paths,
   * queries, commands, names) never enter the canonical history. They remain
   * in the Restate journal.
   */
  summary?: string;
  /**
   * Guidance added to the agent's system prompt in turns where this tool is
   * offered: when to use it and how, beyond what its description says about
   * one call. An agent without the tool is never told about it.
   */
  instructions?: string;
  /**
   * Why the tool cannot be used in this turn, or undefined when it can. The
   * runtime hides an unavailable tool from the model and refuses its calls.
   * Permissions are checked separately; this is for the tool's own switches.
   */
  unavailable?(context: ToolAvailabilityContext): string | undefined;
  run(
    input: z.output<Schema>,
    context: ToolCallContext,
  ): restate.Operation<ToolExecution>;
  complete?(
    input: z.output<Schema>,
    context: ToolCallContext,
  ): restate.Operation<ToolCompletion>;
}): AgentTool {
  const {name, description, inputSchema, summary, instructions} = definition;
  return {
    name,
    description,
    inputSchema,
    summary,
    instructions,
    unavailable: definition.unavailable,
    *execute(input, context) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success)
        return failed(`invalid input: ${validationMessage(parsed.error)}`);
      return yield* definition.run(parsed.data, context);
    },
    *complete(input, context) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success)
        return failed(
          `invalid pending input: ${validationMessage(parsed.error)}`,
        );
      if (!definition.complete)
        return failed(`${name} did not provide a pending completion`);
      return yield* definition.complete(parsed.data, context);
    },
  };
}

/** The first few Zod issues, as `path: message` feedback for the model. */
export function validationMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
