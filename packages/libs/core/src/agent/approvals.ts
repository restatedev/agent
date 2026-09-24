// Pending human approvals. The Agent owns their durable state; the waiting
// tool or policy gate stays inside the turn and receives the decision as a
// signal on its invocation.

import type {ApprovalDecision, ApprovalRequest} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";

import {approvalSignalName} from "../internal-types.js";
import {listState} from "../state.js";
import * as activeTurn from "./active-turn.js";
import type {AgentHandlers} from "./guards.js";
import * as notifications from "./notifications.js";

const approvals = listState<ApprovalRequest>("approvals");

export const handlers: AgentHandlers<
  "requestApproval" | "cancelApproval" | "approvals" | "resolveApproval"
> = {
  /**
   * Registers a request from the active, non-interrupting turn. Idempotent
   * for an identical request; a conflicting one with the same ID is rejected.
   */
  *requestApproval(request) {
    if (!(yield* activeTurn.accepting(request.turnId))) return false;
    const pending = yield* approvals.get();
    const existing = pending.find((p) => p.approvalId === request.approvalId);
    if (existing)
      return (
        existing.turnId === request.turnId &&
        existing.question === request.question &&
        existing.guardrailId === request.guardrailId
      );
    approvals.set([...pending, request]);
    yield* notifications.publish("approvals");
    return true;
  },

  /** Removes a request abandoned by interruption or turn failure. */
  *cancelApproval({approvalId, turnId}) {
    yield* remove((p) => p.approvalId === approvalId && p.turnId === turnId);
  },

  *approvals() {
    return yield* approvals.get();
  },

  /**
   * Signals the decision to the waiting turn, which records it in its
   * transcript. Accepted only while that turn is active and not interrupting.
   */
  *resolveApproval({approvalId, decision, reason}) {
    const request = (yield* approvals.get()).find(
      (p) => p.approvalId === approvalId,
    );
    if (!request || !(yield* activeTurn.accepting(request.turnId)))
      return false;
    yield* remove((p) => p.approvalId === approvalId);
    restate
      .invocation(request.turnId)
      .signal<ApprovalDecision>(approvalSignalName(approvalId))
      .resolve({decision, ...(reason ? {reason} : {})});
    return true;
  },
};

/** Drops every approval of an ended turn. */
export function* clearTurn(turnId: string): restate.Operation<void> {
  yield* remove((p) => p.turnId === turnId);
}

export function* clearAll(): restate.Operation<void> {
  yield* remove(() => true);
}

function* remove(
  match: (request: ApprovalRequest) => boolean,
): restate.Operation<void> {
  const pending = yield* approvals.get();
  const remaining = pending.filter((p) => !match(p));
  if (remaining.length === pending.length) return;
  approvals.set(remaining);
  yield* notifications.publish("approvals");
}
