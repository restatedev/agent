// Wire contracts shared by Restate handlers and signals. Zod schemas are the
// source of truth; only values needed by another module are exported.

import {z} from "zod";

// Durable signal names shared by the Agent sender and Turn receiver.
export const TURN_SIGNALS = {
  interrupt: "interrupt",
  steering: "steering",
} as const;

// One controller steering decision. Queued messages keep their original order
// and the explicit steering message remains distinguishable at the loop.
export type SteeringSignal = {
  queued: string[];
  message: string;
};

// How a turn ended.
const TurnStatusSchema = z.enum(["completed", "interrupted", "failed"]);

// How a user message entered the agent's execution. A queued message can later
// be promoted to steering or activated by a dispatch event without moving it
// from its original transcript position.
const UserMessageDeliverySchema = z.enum(["turn", "steer", "queued"]);

// An entry in the general conversation. Messages record how they entered the
// execution, lifecycle boundaries are explicit events, and assistant entries
// are terminal turn summaries correlated with Restate observability.
const ConversationEventSchema = z.discriminatedUnion("type", [
  z.object({
    role: z.literal("event"),
    type: z.literal("interrupt"),
    turnId: z.string(),
    reason: z.string(),
  }),
  z.object({
    role: z.literal("event"),
    type: z.literal("dispatch"),
    queuedMessages: z.number().int().positive(),
  }),
]);

export const ConversationEntrySchema = z.union([
  z.object({
    role: z.literal("user"),
    text: z.string(),
    delivery: UserMessageDeliverySchema.optional(),
  }),
  z.object({
    role: z.literal("assistant"),
    text: z.string(),
    turnId: z.string(),
    status: z.enum(["completed", "failed"]),
  }),
  ConversationEventSchema,
]);
export type ConversationEntry = z.infer<typeof ConversationEntrySchema>;

// Input to a turn: which Agent object it belongs to, an optional checkpoint
// over older entries, and the exact uncompacted transcript the model should
// see. New messages are already appended to this transcript before dispatch.
export const TurnRequestSchema = z.object({
  agentId: z.string(),
  summary: z.string().min(1).optional(),
  history: z.array(ConversationEntrySchema),
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

// The single outcome a turn reports back to the general conversation: its own
// id (so the Agent can confirm identity), how it ended, and the summary text.
export const TurnOutcomeSchema = z.object({
  turnId: z.string(),
  status: TurnStatusSchema,
  text: z.string(),
  // Number of steering signals this turn actually consumed, in FIFO order.
  // The Agent uses it to recover every history message carried by unconsumed
  // signal batches when completion races with steering.
  consumedSteering: z.number().int().nonnegative().default(0),
});
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

// A human approval requested by a tool running inside a Turn invocation.
export const ApprovalRequestSchema = z.object({
  approvalId: z.string().min(1),
  turnId: z.string().min(1),
  question: z.string().min(1),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// The decision delivered back to the waiting tool over a durable signal.
const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

// Approval tools and the Agent controller use this name as their shared
// Turn-scoped signal contract.
export function approvalSignalName(approvalId: string): string {
  return `approval-${approvalId}`;
}

// Public input used to resolve one pending approval on the Agent object.
export const ApprovalResolutionSchema = ApprovalDecisionSchema.extend({
  approvalId: z.string().min(1),
});
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

// Internal cleanup request used when a waiting tool is interrupted.
export const ApprovalCancellationSchema = ApprovalRequestSchema.pick({
  approvalId: true,
  turnId: true,
});
export type ApprovalCancellation = z.infer<typeof ApprovalCancellationSchema>;
