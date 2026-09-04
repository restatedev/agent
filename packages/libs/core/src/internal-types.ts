// Durable coordination contracts used only inside the Restate service package.
// Public Agent/client wire contracts live in @restate-agents/types.

import type {
  AgentTurnOutcome,
  AgentTurnRequest,
  ApprovalCancellation,
  ConversationCompactionPlan,
  ConversationEntry,
  MemoryUpdate,
  MemoryUpdateResult,
} from "@restate-agents/types";

export type {
  AgentTurnOutcome,
  AgentTurnRequest,
  ApprovalCancellation,
  MemoryUpdate,
  MemoryUpdateResult,
};

export const AGENT_SESSION_SIGNALS = {
  interrupt: "interrupt",
  steering: "steering",
} as const;

export type AgentSessionSteering = {
  queued: ConversationEntry[];
  message: string;
};

export type ConversationCompactionInput = ConversationCompactionPlan & {
  previousSummary?: string;
  entries: ConversationEntry[];
};

export function approvalSignalName(approvalId: string): string {
  return `approval-${approvalId}`;
}

export function mcpAuthorizationSignalName(authRequestId: string): string {
  return `mcp-authorization-${authRequestId}`;
}

type DerivedConversationEvent = Extract<
  ConversationEntry,
  {
    role: "event";
    type:
      | "approval_request"
      | "approval_cancelled"
      | "progress"
      | "activity"
      | "tools"
      | "memory"
      | "delivery";
  }
>;

export function isDerivedConversationEvent(
  entry: ConversationEntry,
): entry is DerivedConversationEvent {
  if (entry.role !== "event") {
    return false;
  }
  switch (entry.type) {
    case "approval_request":
    case "approval_cancelled":
    case "progress":
    case "activity":
    case "tools":
    case "memory":
    case "delivery":
      return true;
    case "interrupt":
    case "stop":
    case "dispatch":
    case "steer":
    case "approval":
      return false;
  }
}
