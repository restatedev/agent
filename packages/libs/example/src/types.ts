// Wire contracts shared by Restate handlers and signals. Zod schemas are the
// source of truth; only values needed by another module are exported.

import {z} from "zod";

// Durable signal names shared by the Agent sender and Turn receiver.
export const TURN_SIGNALS = {
  interrupt: "interrupt",
  steering: "steering",
} as const;

// One controller steering decision. Queued messages keep their original order
// and the explicit steering message remains distinguishable inside Turn.
export type SteeringSignal = {
  queued: string[];
  message: string;
};

// How the Agent originally accepted a user message. This never changes; later
// steering and dispatch events record when queued work enters a Turn.
const UserMessageDeliverySchema = z.enum(["turn", "steer", "queued"]);

const ProgressPhaseSchema = z.enum([
  "thinking",
  "tools",
  "waiting",
  "finalizing",
]);

// A semantic progress update sent from one active Turn to its Agent.
export const ProgressReportSchema = z.object({
  turnId: z.string(),
  phase: ProgressPhaseSchema,
  message: z.string(),
});
export type ProgressReport = z.infer<typeof ProgressReportSchema>;

// Durable prompt context owned by one Agent. Instructions are authoritative
// user configuration, memories are model-managed data, and guardrails deny
// concrete runtime capabilities.
export const MemoryEntrySchema = z.object({
  key: z.string().trim().min(1),
  content: z.string().trim().min(1),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export const MemoryChangeSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("set"),
    key: z.string().trim().min(1),
    content: z.string().trim().min(1),
  }),
  z.object({
    operation: z.literal("delete"),
    key: z.string().trim().min(1),
  }),
]);
export type MemoryChange = z.infer<typeof MemoryChangeSchema>;

export const GuardrailSchema = z.object({
  capability: z.string().trim().min(1),
  reason: z.string().trim().min(1),
});
export type Guardrail = z.infer<typeof GuardrailSchema>;

export const AgentProfileSchema = z.object({
  instructions: z.string().optional(),
  memories: z.array(MemoryEntrySchema),
  guardrails: z.array(GuardrailSchema),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

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
  z.object({
    role: z.literal("event"),
    type: z.literal("steer"),
    turnId: z.string(),
    queuedMessages: z.number().int().nonnegative(),
  }),
  z.object({
    role: z.literal("event"),
    type: z.literal("memory"),
    turnId: z.string(),
    changes: z.array(
      z.object({
        operation: z.enum(["set", "delete"]),
        key: z.string(),
      }),
    ),
  }),
  ProgressReportSchema.extend({
    role: z.literal("event"),
    type: z.literal("progress"),
  }),
]);

const ConversationEntrySchema = z.union([
  z.object({
    role: z.literal("user"),
    text: z.string(),
    delivery: UserMessageDeliverySchema,
  }),
  z.object({
    role: z.literal("assistant"),
    text: z.string(),
    turnId: z.string(),
    status: z.enum(["completed", "interrupted", "failed"]),
  }),
  ConversationEventSchema,
]);
export type ConversationEntry = z.infer<typeof ConversationEntrySchema>;

const SequencedConversationEntrySchema = z.object({
  sequence: z.number().int().positive(),
  entry: ConversationEntrySchema,
});

export const HistoryPageSchema = z.object({
  entries: z.array(SequencedConversationEntrySchema),
  nextSequence: z.number().int().positive(),
});
export type HistoryPage = z.infer<typeof HistoryPageSchema>;

// Input to a turn: which Agent object it belongs to, its stable profile
// snapshot, an optional checkpoint over older entries, and the exact
// uncompacted transcript. New messages are already appended before dispatch.
export const TurnRequestSchema = AgentProfileSchema.extend({
  agentId: z.string(),
  summary: z.string().min(1).optional(),
  history: z.array(ConversationEntrySchema),
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

const TurnOutcomeBaseSchema = z.object({
  turnId: z.string(),
  // Number of steering signals this turn actually consumed, in FIFO order.
  // The Agent uses it to recover every history message carried by unconsumed
  // signal batches when completion races with steering.
  consumedSteering: z.number().int().nonnegative(),
});

// The single structured outcome a Turn reports to its Agent.
export const TurnOutcomeSchema = z.discriminatedUnion("status", [
  TurnOutcomeBaseSchema.extend({
    status: z.literal("completed"),
    response: z.string(),
  }),
  TurnOutcomeBaseSchema.extend({
    status: z.literal("interrupted"),
    reason: z.string(),
    // Graceful interruption produces a final response. Hard invocation
    // cancellation can still retire the Turn without one.
    response: z.string().optional(),
  }),
  TurnOutcomeBaseSchema.extend({
    status: z.literal("failed"),
    error: z.string(),
  }),
]);
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
