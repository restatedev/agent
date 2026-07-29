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

const ScheduleWhenBusySchema = z
  .enum(["queue", "steer", "interrupt"])
  .describe(
    "How a due message enters the conversation when a Turn is active. Queue is the default unless the user explicitly asks to affect current work.",
  );

const ScheduleIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe(
    "A stable human-readable identifier. Reusing it replaces the existing schedule.",
  );

export const ScheduleSpecSchema = z.object({
  scheduleId: ScheduleIdSchema,
  message: z
    .string()
    .trim()
    .min(1)
    .describe("The user request to deliver when the schedule becomes due."),
  delaySeconds: z
    .number()
    .int()
    .min(1)
    .max(31_536_000)
    .describe("Seconds from now until the first delivery."),
  repeatEverySeconds: z
    .number()
    .int()
    .min(1)
    .max(31_536_000)
    .nullable()
    .describe(
      "Fixed delay between later deliveries, or null for a one-shot schedule.",
    ),
  whenBusy: ScheduleWhenBusySchema,
});

export const ScheduledMessageSchema = ScheduleSpecSchema.omit({
  delaySeconds: true,
}).extend({
  nextRunAt: z
    .number()
    .int()
    .nonnegative()
    .describe("Unix epoch milliseconds for the next delivery."),
});
export type ScheduledMessage = z.infer<typeof ScheduledMessageSchema>;

export const ScheduleMutationSchema = z.object({
  turnId: z.string().min(1).nullable(),
  schedule: ScheduleSpecSchema.extend({
    whenBusy: ScheduleWhenBusySchema.optional(),
  }),
});
export type ScheduleMutation = z.infer<typeof ScheduleMutationSchema>;

export const ScheduleMutationResultSchema = z.discriminatedUnion("accepted", [
  z.object({
    accepted: z.literal(true),
    replaced: z.boolean(),
    schedule: ScheduledMessageSchema,
  }),
  z.object({
    accepted: z.literal(false),
    error: z.string(),
  }),
]);
export type ScheduleMutationResult = z.infer<
  typeof ScheduleMutationResultSchema
>;

export const ScheduleCancellationSchema = z.object({
  turnId: z.string().min(1).nullable(),
  scheduleId: ScheduleIdSchema,
});
export type ScheduleCancellation = z.infer<typeof ScheduleCancellationSchema>;

export const ScheduleCancellationResultSchema = z.discriminatedUnion(
  "accepted",
  [
    z.object({
      accepted: z.literal(true),
      cancelled: z.boolean(),
    }),
    z.object({
      accepted: z.literal(false),
      error: z.string(),
    }),
  ],
);
export type ScheduleCancellationResult = z.infer<
  typeof ScheduleCancellationResultSchema
>;

export const ScheduleFireSchema = z.object({
  scheduleId: ScheduleIdSchema,
});

const ProgressPhaseSchema = z.enum(["thinking", "waiting", "finalizing"]);

// A semantic progress update sent from one active Turn to its Agent.
export const ProgressReportSchema = z.object({
  turnId: z.string(),
  phase: ProgressPhaseSchema,
  message: z.string(),
});
export type ProgressReport = z.infer<typeof ProgressReportSchema>;

export const SandboxEventSchema = z.object({
  turnId: z.string(),
  status: z.enum(["provisioned", "suspended"]),
});
export type SandboxEvent = z.infer<typeof SandboxEventSchema>;

const ToolExecutionStatusSchema = z.enum([
  "succeeded",
  "failed",
  "pending",
  "cancelled",
]);

const ActivityReportSchema = z.object({
  type: z.literal("activity"),
  turnId: z.string(),
  step: z.number().int().positive(),
  message: z.string().trim().min(1),
});

const ToolReportSchema = z.object({
  type: z.literal("tools"),
  turnId: z.string(),
  step: z.number().int().positive(),
  phase: z.enum(["started", "finished"]),
  calls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: ToolExecutionStatusSchema.optional(),
    }),
  ),
});

export const ExecutionReportSchema = z.discriminatedUnion("type", [
  ActivityReportSchema,
  ToolReportSchema,
]);
export type ExecutionReport = z.infer<typeof ExecutionReportSchema>;

// Durable prompt context owned by one Agent. Instructions are authoritative
// user configuration, memories are model-managed data, and guardrails are
// natural-language policies enforced against proposed agent actions.
const MemoryEntrySchema = z.object({
  key: z.string().trim().min(1),
  content: z.string().trim().min(1),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

const MemoryChangeSchema = z.discriminatedUnion("operation", [
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

export const GuardrailSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .describe(
        "A stable identifier used to correlate this policy with runtime decisions and human approvals.",
      ),
    rule: z
      .string()
      .trim()
      .min(1)
      .describe(
        "A natural-language policy describing behavior to allow, deny, or require human approval for.",
      ),
  })
  .describe("A natural-language policy evaluated before an agent action runs.");
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

// The decision delivered to a waiting tool or policy gate over a signal and
// retained in history after successful delivery.
const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

const ProfileEventSchema = z.object({
  role: z.literal("event"),
  type: z.literal("profile"),
  change: z.discriminatedUnion("field", [
    z.object({
      field: z.literal("instructions"),
      configured: z.boolean(),
    }),
    z.object({
      field: z.literal("guardrails"),
      ids: z.array(z.string()),
    }),
  ]),
});

const ApprovalRequestEventSchema = z.object({
  role: z.literal("event"),
  type: z.literal("approval_request"),
  approvalId: z.string(),
  turnId: z.string(),
  question: z.string(),
  guardrailId: z.string().optional(),
});

const ApprovalCancelledEventSchema = z.object({
  role: z.literal("event"),
  type: z.literal("approval_cancelled"),
  approvalId: z.string(),
  turnId: z.string(),
});

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
  z.object({
    role: z.literal("event"),
    type: z.literal("schedule"),
    scheduleId: ScheduleIdSchema,
    action: z.enum(["created", "updated", "cancelled", "fired"]),
    turnId: z.string().optional(),
    nextRunAt: z.number().int().nonnegative().optional(),
    whenBusy: ScheduleWhenBusySchema.optional(),
    routing: z.enum(["start", "queue", "steer", "interrupt"]).optional(),
  }),
  z
    .object({
      role: z.literal("event"),
      type: z.literal("approval"),
      approvalId: z.string(),
      turnId: z.string(),
      question: z.string(),
      guardrailId: z.string().optional(),
    })
    .extend(ApprovalDecisionSchema.shape),
  ApprovalRequestEventSchema,
  ApprovalCancelledEventSchema,
  ProfileEventSchema,
  ProgressReportSchema.extend({
    role: z.literal("event"),
    type: z.literal("progress"),
  }),
  SandboxEventSchema.extend({
    role: z.literal("event"),
    type: z.literal("sandbox"),
  }),
  ActivityReportSchema.extend({
    role: z.literal("event"),
  }),
  ToolReportSchema.extend({
    role: z.literal("event"),
  }),
]);

const ConversationEntrySchema = z.discriminatedUnion("role", [
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
// snapshot, an optional checkpoint over older entries, and the model-relevant
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

// A human approval requested by a tool or runtime policy gate inside a Turn.
export const ApprovalRequestSchema = z.object({
  approvalId: z.string().min(1),
  turnId: z.string().min(1),
  question: z.string().min(1),
  guardrailId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The policy that opened this approval, omitted for approvals requested directly by the agent.",
    ),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// Approval producers and the Agent controller share this Turn-scoped signal
// naming contract.
export function approvalSignalName(approvalId: string): string {
  return `approval-${approvalId}`;
}

// Public input used to resolve one pending approval on the Agent object.
export const ApprovalResolutionSchema = ApprovalDecisionSchema.extend({
  approvalId: z.string().min(1),
});
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

// Internal cleanup request used when a waiting approval is interrupted.
export const ApprovalCancellationSchema = ApprovalRequestSchema.pick({
  approvalId: true,
  turnId: true,
});
export type ApprovalCancellation = z.infer<typeof ApprovalCancellationSchema>;
