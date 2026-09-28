// How to write a built-in tool: `defineAgentTool`, the context a tool body
// receives, and the result helpers every tool uses. The tools themselves live
// in `src/tools/`, and `src/agent-config.ts` chooses which ones the agent has.
//
// ## How a tool runs
//
// A turn is one durable Restate invocation (AgentSession.doTurn) made of
// steps. In each step the model answers with text or with a batch of tool
// calls. The guardrails check the batch, then every allowed call in it
// starts at once, as a task of the turn, and the step waits for all of them.
// (The one exception: if the user steers while an executeProgram program is
// still running, the step hands the program to the turn as pending work so
// the new input is not held back; see session/step.ts.) The results go back
// to the model together as one tool message, and the next step begins.
//
// A tool body is durable handler code, not an ordinary async function. It is
// a generator that yields Restate operations, and after a crash or restart
// Restate replays it from its journal: operations that already completed
// return their recorded results instead of running again. So a tool must
// put every side effect or non-deterministic value (HTTP, clocks, random
// numbers, the sandbox) inside `restate.run` (or `toolRun` below), or reach
// it through another Restate handler (`restate.client(...)`). Code between
// those operations runs again on every replay and must decide the same way.
//
// ## `run` and `complete`: foreground and pending tools
//
// Every tool has `run`. It is called when the model makes the call, and its
// result is the call's result: what the model sees at its next step.
//
// Most tools are foreground tools: `run` does the work and returns
// `succeeded` or `failed`. The step waits for it, so a foreground tool should
// finish in seconds, not minutes. `getWeather`, `webSearch`, the memory and
// sandbox tools all work this way.
//
// Some work takes much longer than a step should wait: a timer, a person's
// decision. Such a tool is split in two:
//
//   1. `run` starts the operation and returns right away with
//      `{status: "pending", result: {operationId, ...}}`. The model sees that
//      result at its next step and can keep working: answer the user, call
//      other tools, or cancel the operation with cancelOperation.
//   2. `complete` waits for the operation to end. The runtime calls it as a
//      background task of the turn (session/pending.ts), outside any one
//      step, and it may take as long as it needs. When it settles, its
//      result reaches the model as a runtime message before a later step.
//      A call has only one tool result, and it was already `pending`.
//
//   model calls sleep ─> run() ──> {status: "pending", operationId}   (step N)
//                        complete() ─> durable timer ... fires
//                        ─> "[Runtime event] Pending tool sleep completed" (step N+k)
//
// `complete` gets the same input and the same `toolCallId` as `run`, but no
// value from it. `run` has returned, and on replay only the journal connects
// the two. So anything `complete` needs must be derivable from the input and
// the call ID. `humanApproval` uses the call ID as its approval ID, and
// `complete` waits on the signal named after it. `sleep` names its timer
// after it.
//
// Pending work is bounded by its turn: the turn does not finish while any is
// still running. If the turn is interrupted, or the model calls
// cancelOperation with the operation ID, the runtime interrupts the
// `complete` task. The call then ends as `cancelled`, which the model is
// told about like any other completion. `cancelOperation` itself returns the
// fourth status, `cancel_requested`, which only the runtime acts on.
//
// Inside an executeProgram program there is no later step to report to, so
// a nested pending call is completed inline: the program's `await` resolves
// only when `complete` does.
//
// ## Results and errors
//
// A result is a string for the model (JSON when it is structured). Return
// `failed(...)` for anything the model can react to: bad input, a missing
// file, a rejected request. Throw only for what the model cannot fix. The
// helpers below turn unexpected errors into `failed` and always rethrow
// cancellation, so an interrupted turn stops instead of reporting a failed
// tool. A tool may also return `transcript` entries, events added to the
// public conversation history (memory changes, approval requests).

import type {AgentTools, ConversationEntry} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import type {z} from "zod";

import {errorMessage, isCancellation, isRejection} from "./errors.js";
import type {TurnSandbox} from "./sandbox/index.js";

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

/**
 * The turn's search over its permitted catalog. Only the runtime's own
 * searchTools uses it; it is created lazily by the dispatcher.
 */
export type TurnToolSearch = {
  loaded: Set<string>;
  search(query: string): string[];
  load(names: string[]): {name: string; description: string}[];
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
  /**
   * Runs when the model makes the call; its result is the call's result. A
   * foreground tool does its work here. A pending tool only starts it and
   * returns `{status: "pending"}`. See "run and complete" at the top.
   */
  run(
    input: z.output<Schema>,
    context: ToolCallContext,
  ): restate.Operation<ToolExecution>;
  /**
   * Only for pending tools: waits, as a background task of the turn, for the
   * operation `run` started, with the same input and toolCallId. Its result
   * reaches the model as a runtime message. An interrupted or cancelled
   * operation interrupts this task.
   */
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
