// Durable coordination contracts used only inside the Restate service package.
// Public Agent/client wire contracts live in @restate-agents/types.

import {
  AgentProfileSchema,
  ApprovalRequestSchema,
  type ConversationEntry,
  ConversationEntrySchema,
  MemoryChangeSchema,
  ScheduleSpecSchema,
} from "@restate-agents/types";
import {z} from "zod";

export const AGENT_SESSION_SIGNALS = {
  interrupt: "interrupt",
  steering: "steering",
} as const;

export type AgentSessionSteering = {
  queued: ConversationEntry[];
  message: string;
};

export const AgentSessionRequestSchema = AgentProfileSchema.extend({
  entries: z.array(ConversationEntrySchema),
});
export type AgentSessionRequest = z.infer<typeof AgentSessionRequestSchema>;

const AgentSessionOutcomeBaseSchema = z.object({
  turnId: z.string(),
  consumedSteering: z.number().int().nonnegative(),
});

export const AgentSessionOutcomeSchema = z.discriminatedUnion("status", [
  AgentSessionOutcomeBaseSchema.extend({
    status: z.literal("completed"),
    response: z.string(),
  }),
  AgentSessionOutcomeBaseSchema.extend({
    status: z.literal("interrupted"),
    reason: z.string(),
    response: z.string().optional(),
  }),
  AgentSessionOutcomeBaseSchema.extend({
    status: z.literal("stopped"),
    cause: z.enum(["step_limit", "tool_limit"]),
    reason: z.string(),
    response: z.string(),
  }),
  AgentSessionOutcomeBaseSchema.extend({
    status: z.literal("failed"),
    error: z.string(),
  }),
]);
export type AgentSessionOutcome = z.infer<typeof AgentSessionOutcomeSchema>;

export const AgentNotificationTopicSchema = z.enum([
  "history",
  "profile",
  "approvals",
  "schedules",
]);
export type AgentNotificationTopic = z.infer<
  typeof AgentNotificationTopicSchema
>;

export const AgentNotificationSubscriptionSchema = z.object({
  afterRevision: z.number().int().nonnegative(),
  awakeableId: z.string().min(1),
});
export type AgentNotificationSubscription = z.infer<
  typeof AgentNotificationSubscriptionSchema
>;

export const AgentNotificationUnsubscribeSchema = z.object({
  awakeableId: z.string().min(1),
});

export const ScheduleFireSchema = ScheduleSpecSchema.pick({scheduleId: true});

export const MemoryUpdateSchema = z.object({
  turnId: z.string().min(1),
  changes: z.array(MemoryChangeSchema).min(1),
});
export type MemoryUpdate = z.infer<typeof MemoryUpdateSchema>;

export const MemoryUpdateResultSchema = z.discriminatedUnion("applied", [
  z.object({
    applied: z.literal(true),
    memoryCount: z.number().int().nonnegative(),
  }),
  z.object({
    applied: z.literal(false),
    error: z.string(),
  }),
]);
export type MemoryUpdateResult = z.infer<typeof MemoryUpdateResultSchema>;

export function approvalSignalName(approvalId: string): string {
  return `approval-${approvalId}`;
}

export const ApprovalCancellationSchema = ApprovalRequestSchema.pick({
  approvalId: true,
  turnId: true,
});
export type ApprovalCancellation = z.infer<typeof ApprovalCancellationSchema>;

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
      | "schedule";
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
    case "schedule":
      return true;
    case "interrupt":
    case "stop":
    case "dispatch":
    case "steer":
    case "approval":
      return false;
  }
}
