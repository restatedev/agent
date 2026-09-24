// Identity, metadata and authorization shared by every Agent handler group.
//
// Handlers state their preconditions explicitly with one of these guards.
// Nothing here checks deletion as a side effect.

import type {AgentMetadata, AgentTools} from "@restate-agents/types";
import type {AgentDefinition} from "@restate-agents/types/services";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

import {selected} from "../session/tool-permissions.js";
import {objectKey} from "../state.js";
import * as activeTurn from "./active-turn.js";

type AgentHandlerMap =
  typeof AgentDefinition extends restate.ObjectDescriptor<string, infer H>
    ? restate.ImplementHandlers<H>
    : never;

/** A group of Agent handlers implemented in one module. */
export type AgentHandlers<K extends keyof AgentHandlerMap> = Pick<
  AgentHandlerMap,
  K
>;

export const forbidden = (message: string) =>
  new TerminalError(message, {errorCode: 403});
export const conflict = (message: string) =>
  new TerminalError(message, {errorCode: 409});

export function* isDeleted(): restate.Operation<boolean> {
  return (yield* restate.sharedState().get<boolean>("deleted")) ?? false;
}

export function* requireLive(): restate.Operation<void> {
  if (yield* isDeleted())
    throw new TerminalError("Agent has been deleted", {errorCode: 410});
}

/** Stored metadata, or the defaults of an agent implicitly created by `ask`. */
export function* readMetadata(): restate.Operation<AgentMetadata> {
  return (
    (yield* restate.sharedState().get<AgentMetadata>("metadata")) ?? {
      name: objectKey(),
    }
  );
}

// Child instructions, guardrails and tool grants are fixed at creation. Its
// own turn may still update memory; direct callers cannot widen its access.
export function* requireTopLevel(): restate.Operation<void> {
  if ((yield* readMetadata()).parentAgentId)
    throw forbidden(
      "Only a top-level agent accepts direct messages or profile changes",
    );
}

/** Direct callers (the UI, ingress) act only on a live, top-level agent. */
export function* requireDirectAccess(): restate.Operation<void> {
  yield* requireLive();
  yield* requireTopLevel();
}

// Tool callbacks can arrive after a turn has ended or begun interruption.
// Authorize against the controller's live snapshot, never the caller's copy.
export function* requireActiveTurn(
  turnId: string,
  action: string,
): restate.Operation<AgentTools> {
  const current = yield* activeTurn.current();
  if (current?.id !== turnId || current.interruptReason !== undefined)
    throw conflict(`${action} requires the active, non-interrupting Turn`);
  return current.tools;
}

/** Requires the live turn to hold the named built-in tool. */
export function* requireTurnTool(
  turnId: string,
  tool: string,
  denied: string,
): restate.Operation<AgentTools> {
  const tools = yield* requireActiveTurn(turnId, tool);
  if (!selected(tools.builtin, tool)) throw forbidden(denied);
  return tools;
}
