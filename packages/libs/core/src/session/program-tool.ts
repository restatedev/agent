// PTC adapts the same tool dispatcher used for direct calls. Intermediate
// payloads only cross into QuickJS; the model receives the program's return.
import {CancelledError} from "@restatedev/restate-sdk";
import type {Operation} from "@restatedev/restate-sdk-gen";

import type {ToolCall} from "../model/index.js";
import {PROGRAM_TOOL_NAME, ProgramInputSchema} from "../ptc/definition.js";
import {
  type Json,
  type Outcome,
  ProgramError,
  type Request,
} from "../ptc/guest.js";
import {executeProgram} from "../ptc/runtime.js";
import type {DiscoveredAgentTool} from "./dynamic-tools.js";
import type {McpAgentTool} from "./mcp-tools.js";
import {
  type AgentToolContext,
  approvalCancelled,
  complete,
  execute,
  manifests,
  toolActivity,
  type ToolExecutionScope,
  type ToolOutcome,
  toolsEvent,
  transcriptEntries,
} from "./tools.js";
import {withdrawApproval} from "./tools/approval.js";

export function* executeProgramTool(
  call: ToolCall,
  context: AgentToolContext,
  discovered: DiscoveredAgentTool[],
  mcpTools: McpAgentTool[],
  scope: ToolExecutionScope,
): Operation<ToolOutcome> {
  const parsed = ProgramInputSchema.safeParse(call.input);
  if (!parsed.success)
    return {
      call,
      status: "failed",
      error: `Invalid program input: ${parsed.error.message}`,
    };
  const names = manifests(discovered, mcpTools, context)
    .map((tool) => tool.name)
    .filter((name) => name !== PROGRAM_TOOL_NAME);
  try {
    const value = yield* executeProgram(parsed.data.source, {
      names,
      *execute(request) {
        return yield* executeNestedTool(
          request,
          call.toolCallId,
          context,
          discovered,
          mcpTools,
          scope,
        );
      },
    });
    return {call, status: "succeeded", result: JSON.stringify(value)};
  } catch (error) {
    // Never turn attempt failure, SDK cancellation, or turn interruption into a
    // successful model round. Only known guest failures are repairable here.
    if (!(error instanceof ProgramError)) throw error;
    return {call, status: "failed", error: `Program failed: ${error.message}`};
  }
}

function* executeNestedTool(
  request: Request,
  parentId: string,
  context: AgentToolContext,
  discovered: DiscoveredAgentTool[],
  mcpTools: McpAgentTool[],
  scope: ToolExecutionScope,
): Operation<Outcome> {
  const call: ToolCall = {
    toolCallId: `${parentId}:${request.id}`,
    toolName: request.name,
    input: request.args[0],
  };
  if (
    request.args.length !== 1 ||
    typeof call.input !== "object" ||
    call.input === null ||
    Array.isArray(call.input)
  ) {
    return failure(
      "Call a tool with exactly one input object matching its schema (use {} for no arguments)",
    );
  }
  const denied = yield* scope.guard(call);
  if (denied) return failure(`Tool blocked: ${denied}`);

  const report = (status?: "succeeded" | "failed" | "cancelled") =>
    scope.transcript.append(
      toolsEvent(context.turnId, scope.step, status ? "finished" : "started", [
        toolActivity(call, status),
      ]),
    );
  yield* report();
  let pendingApproval = false;
  let finished = false;
  try {
    let outcome = yield* execute(call, context, discovered, mcpTools);
    pendingApproval =
      outcome.status === "pending" && call.toolName === "humanApproval";
    yield* scope.transcript.append(...transcriptEntries(outcome, context));
    if (outcome.status === "cancel_requested")
      outcome = yield* scope.cancelPending(outcome);
    if (outcome.status === "pending") {
      const event = yield* complete(call, context, scope.step);
      pendingApproval = false;
      yield* scope.transcript.append(...transcriptEntries(event, context));
      if (event.outcome.status === "cancelled") {
        outcome = {call, status: "failed", error: event.outcome.reason};
      } else {
        outcome = {call, ...event.outcome};
      }
    }
    yield* report(outcome.status === "succeeded" ? "succeeded" : "failed");
    finished = true;
    if (outcome.status === "failed") return failure(outcome.error);
    if (outcome.status !== "succeeded")
      throw new Error(`Unresolved nested tool outcome: ${outcome.status}`);
    // Preserve the direct result contract. JSON-producing tools become values;
    // text-producing tools remain strings. Approval decisions stay explicit.
    return {ok: true, value: parseResult(outcome.result)};
  } catch (error) {
    // Close the registration-to-wait gap if interruption arrives while the
    // approval_request transcript is being published, before complete starts.
    if (!(error instanceof CancelledError)) {
      if (pendingApproval) {
        yield* withdrawApproval(context, call.toolCallId);
        yield* scope.transcript.append(
          approvalCancelled(call.toolCallId, context.turnId),
        );
      }
      if (!finished) yield* report("cancelled");
    }
    throw error;
  }
}

function parseResult(result: string): Json {
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

function failure(message: string): Outcome {
  return {ok: false, error: {name: "Error", message}};
}
