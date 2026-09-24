// The shape of a built-in tool and the helpers every tool body uses.

import type {AgentTools, ConversationEntry} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import type {z} from "zod";

import {errorMessage, isCancellation, isRejection} from "../../errors.js";
import type {ToolCall} from "../../model/index.js";
import type {TurnSandbox} from "../../sandbox/index.js";
import type {TurnHistory} from "../history.js";
import type {TurnToolSearch} from "../tool-search.js";

type ToolTranscript = {transcript?: ConversationEntry[]};
type Failed = {status: "failed"; error: string};

export type ToolExecution = (
  | {status: "succeeded"; result: string}
  | Failed
  | {status: "pending"; result: Record<string, unknown>}
  | {status: "cancel_requested"; operationId: string; reason: string}
) &
  ToolTranscript;

export type ToolCompletion = (
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

/** Agent- and turn-scoped capabilities passed to tool definitions. */
export type AgentToolContext = {
  agentId: string;
  turnId: string;
  webSearchEnabled: boolean;
  permissions: AgentTools;
  toolSearch?: TurnToolSearch;
  sandbox: TurnSandbox;
};

/** Step-owned policy and lifecycle hooks used by PTC's nested calls. */
export type ToolExecutionScope = {
  transcript: TurnHistory;
  step: number;
  guard(call: ToolCall): restate.Operation<string | undefined>;
  cancelPending(outcome: ToolOutcome): restate.Operation<ToolOutcome>;
};

export type ToolCallContext = AgentToolContext & {toolCallId: string};

export type AgentTool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  summary?: string;
  execute(
    input: unknown,
    context: ToolCallContext,
  ): restate.Operation<ToolExecution>;
  complete(
    input: unknown,
    context: ToolCallContext,
  ): restate.Operation<ToolCompletion>;
};

export const succeeded = (result: string) =>
  ({status: "succeeded", result}) as const;
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
  run(
    input: z.output<Schema>,
    context: ToolCallContext,
  ): restate.Operation<ToolExecution>;
  complete?(
    input: z.output<Schema>,
    context: ToolCallContext,
  ): restate.Operation<ToolCompletion>;
}): AgentTool {
  const {name, description, inputSchema, summary} = definition;
  return {
    name,
    description,
    inputSchema,
    summary,
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

function validationMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
