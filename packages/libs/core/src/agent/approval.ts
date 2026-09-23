// Pending human approvals for one Agent virtual object. The Agent owns their
// durable state; the waiting tool or policy gate remains inside the Turn.

import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolution,
} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import {
  type ApprovalCancellation,
  approvalSignalName,
} from "../internal-types.js";

const APPROVALS = "approvals";

/** Returns every approval currently waiting for a human decision. */
export function* list(): restate.Operation<ApprovalRequest[]> {
  return (yield* restate.sharedState().get<ApprovalRequest[]>(APPROVALS)) ?? [];
}

/**
 * Handler-scoped access to human approvals for the current Agent object.
 *
 * These functions must run inside an Agent handler. They use Restate's current
 * context and hold no process-local state.
 */
/** Registers a request idempotently and reports whether it was newly added. */
export function* register(
  request: ApprovalRequest,
): restate.Operation<"added" | "existing" | "rejected"> {
  const pending = yield* list();
  const existing = pending.find(
    (candidate) => candidate.approvalId === request.approvalId,
  );
  if (existing) {
    return existing.turnId === request.turnId &&
      existing.question === request.question &&
      existing.guardrailId === request.guardrailId
      ? "existing"
      : "rejected";
  }
  pending.push(request);
  restate.state().set(APPROVALS, pending);
  return "added";
}

/** Removes one matching request. Safe to repeat during cleanup. */
export function* cancel({
  approvalId,
  turnId,
}: ApprovalCancellation): restate.Operation<ApprovalRequest | undefined> {
  const pending = yield* list();
  const cancelled = pending.find(
    (request) => request.approvalId === approvalId && request.turnId === turnId,
  );
  if (!cancelled) {
    return undefined;
  }
  const remaining = pending.filter(
    (request) => request.approvalId !== approvalId || request.turnId !== turnId,
  );
  storeApprovals(remaining);
  return cancelled;
}

/** Removes every pending approval, reporting whether any existed. */
export function* clearAll(): restate.Operation<boolean> {
  const pending = yield* list();
  restate.state().clear(APPROVALS);
  return pending.length > 0;
}

/** Removes every approval belonging to a completed Turn invocation. */
export function* clearTurn(
  turnId: string,
): restate.Operation<ApprovalRequest[]> {
  const pending = yield* list();
  const cancelled = pending.filter((request) => request.turnId === turnId);
  if (cancelled.length === 0) {
    return [];
  }
  const remaining = pending.filter((request) => request.turnId !== turnId);
  storeApprovals(remaining);
  return cancelled;
}

/**
 * Resolves and removes a request only while its originating Turn remains
 * eligible to receive the decision.
 *
 * @returns The resolved request when the signal was delivered. The waiting
 * AgentSession invocation records the complete decision in its transcript.
 */
export function* resolve(
  resolution: ApprovalResolution,
  activeTurnId?: string,
): restate.Operation<ApprovalRequest | undefined> {
  const pending = yield* list();
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
}

function storeApprovals(pending: ApprovalRequest[]): void {
  if (pending.length === 0) {
    restate.state().clear(APPROVALS);
  } else {
    restate.state().set(APPROVALS, pending);
  }
}
