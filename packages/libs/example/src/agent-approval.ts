// Pending human approvals for one Agent virtual object. The Agent owns their
// durable state; the waiting tool remains inside the Turn invocation.

import {
  invocation,
  type Operation,
  sharedState,
  state,
} from "@restatedev/restate-sdk-gen";
import type {
  ApprovalCancellation,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolution,
} from "./types.js";

const APPROVALS = "approvals";

/** Signal name for one tool call waiting inside a Turn invocation. */
export function approvalSignalName(approvalId: string): string {
  return `approval-${approvalId}`;
}

/** Owns pending human-approval state for the current Agent object. */
export const approvals = {
  /** Returns every approval currently waiting for a human decision. */
  *list(): Operation<ApprovalRequest[]> {
    return (yield* sharedState().get<ApprovalRequest[]>(APPROVALS)) ?? [];
  },

  /** Registers a request idempotently. */
  *register(request: ApprovalRequest): Operation<boolean> {
    const pending = yield* this.list();
    const existing = pending.find(
      (candidate) => candidate.approvalId === request.approvalId,
    );
    if (existing) {
      return (
        existing.turnId === request.turnId &&
        existing.question === request.question
      );
    }
    pending.push(request);
    state().set(APPROVALS, pending);
    return true;
  },

  /** Removes one matching request. Safe to repeat during cleanup. */
  *cancel({approvalId, turnId}: ApprovalCancellation): Operation<void> {
    const pending = yield* this.list();
    const remaining = pending.filter(
      (request) =>
        request.approvalId !== approvalId || request.turnId !== turnId,
    );
    if (remaining.length === pending.length) {
      return;
    }
    if (remaining.length === 0) {
      state().clear(APPROVALS);
    } else {
      state().set(APPROVALS, remaining);
    }
  },

  /** Removes every approval belonging to a completed Turn invocation. */
  *clearTurn(turnId: string): Operation<void> {
    const pending = yield* this.list();
    const remaining = pending.filter((request) => request.turnId !== turnId);
    if (remaining.length === pending.length) {
      return;
    }
    if (remaining.length === 0) {
      state().clear(APPROVALS);
    } else {
      state().set(APPROVALS, remaining);
    }
  },

  /** Removes a pending request and resolves its Turn-scoped signal. */
  *resolve(resolution: ApprovalResolution): Operation<boolean> {
    const pending = yield* this.list();
    const request = pending.find(
      (candidate) => candidate.approvalId === resolution.approvalId,
    );
    if (!request) {
      return false;
    }

    const remaining = pending.filter(
      (candidate) => candidate.approvalId !== resolution.approvalId,
    );
    if (remaining.length === 0) {
      state().clear(APPROVALS);
    } else {
      state().set(APPROVALS, remaining);
    }

    const decision: ApprovalDecision = {
      decision: resolution.decision,
      ...(resolution.reason ? {reason: resolution.reason} : {}),
    };
    invocation(request.turnId)
      .signal<ApprovalDecision>(approvalSignalName(request.approvalId))
      .resolve(decision);
    return true;
  },
};
