// Pending human approvals for one Agent virtual object. The Agent owns their
// durable state; the waiting tool or policy gate remains inside the Turn.

import * as restate from "@restatedev/restate-sdk-gen";
import {
  type ApprovalCancellation,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalResolution,
  approvalSignalName,
} from "./types.js";

const APPROVALS = "approvals";

function* listApprovals(): restate.Operation<ApprovalRequest[]> {
  return (yield* restate.sharedState().get<ApprovalRequest[]>(APPROVALS)) ?? [];
}

function storeApprovals(pending: ApprovalRequest[]): void {
  if (pending.length === 0) {
    restate.state().clear(APPROVALS);
  } else {
    restate.state().set(APPROVALS, pending);
  }
}

/**
 * Handler-scoped access to human approvals for the current Agent object.
 *
 * These operations must run inside an Agent handler. The object is a namespace
 * over Restate's current context and holds no process-local state.
 */
export const approvals = {
  /** Returns every approval currently waiting for a human decision. */
  list: listApprovals,

  /** Registers a request idempotently. */
  *register(request: ApprovalRequest): restate.Operation<boolean> {
    const pending = yield* listApprovals();
    const existing = pending.find(
      (candidate) => candidate.approvalId === request.approvalId,
    );
    if (existing) {
      return (
        existing.turnId === request.turnId &&
        existing.question === request.question &&
        existing.guardrailId === request.guardrailId
      );
    }
    pending.push(request);
    restate.state().set(APPROVALS, pending);
    return true;
  },

  /** Removes one matching request. Safe to repeat during cleanup. */
  *cancel({approvalId, turnId}: ApprovalCancellation): restate.Operation<void> {
    const pending = yield* listApprovals();
    const remaining = pending.filter(
      (request) =>
        request.approvalId !== approvalId || request.turnId !== turnId,
    );
    if (remaining.length === pending.length) {
      return;
    }
    storeApprovals(remaining);
  },

  /** Removes every approval belonging to a completed Turn invocation. */
  *clearTurn(turnId: string): restate.Operation<void> {
    const pending = yield* listApprovals();
    const remaining = pending.filter((request) => request.turnId !== turnId);
    if (remaining.length === pending.length) {
      return;
    }
    storeApprovals(remaining);
  },

  /**
   * Resolves and removes a request only while its originating Turn remains
   * eligible to receive the decision.
   *
   * @returns The resolved request when the signal was delivered, allowing the
   * Agent to record the complete decision in its transcript.
   */
  *resolve(
    resolution: ApprovalResolution,
    activeTurnId?: string,
  ): restate.Operation<ApprovalRequest | undefined> {
    const pending = yield* listApprovals();
    const request = pending.find(
      (candidate) => candidate.approvalId === resolution.approvalId,
    );
    if (!request) {
      return undefined;
    }
    if (request.turnId !== activeTurnId) {
      return undefined;
    }

    const remaining = pending.filter(
      (candidate) => candidate.approvalId !== resolution.approvalId,
    );
    storeApprovals(remaining);

    const decision: ApprovalDecision = {
      decision: resolution.decision,
      ...(resolution.reason ? {reason: resolution.reason} : {}),
    };
    restate
      .invocation(request.turnId)
      .signal<ApprovalDecision>(approvalSignalName(request.approvalId))
      .resolve(decision);
    return request;
  },
};
