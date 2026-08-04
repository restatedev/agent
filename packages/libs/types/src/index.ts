// Public wire contracts for the Restate agent runtime. Zod schemas are the
// source of truth shared by the service implementation and external clients.

import {z} from "zod";
import {DEFAULT_ASK} from "./targets.js";

export {DEFAULT_ASK} from "./targets.js";

export const MessageSchema = z.string().trim().min(1);

export const AskRequestSchema = z.object({
  message: MessageSchema.default(DEFAULT_ASK),
});

export const InterruptRequestSchema = z
  .object({
    reason: MessageSchema.describe(
      "Why the active Turn should stop and what its tool-free finalization should explain.",
    ),
    message: MessageSchema.describe(
      "An optional replacement user request to queue for a new Turn after interruption finalization.",
    ).optional(),
  })
  .describe(
    "Interrupt the active Turn, optionally preserving a replacement request for the next Turn.",
  );

export const SetInstructionsSchema = z.object({
  instructions: z.string().nullable(),
});

const AskStatsSchema = z.object({
  pendingMessages: z.number().int().nonnegative(),
});

/** The Agent controller's routing decision for a newly accepted message. */
export const AskResultSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("start"),
    turnId: z.string(),
    stats: AskStatsSchema,
  }),
  z.object({
    decision: z.literal("queue"),
    turnId: z.null(),
    activeTurnId: z.string(),
    stats: AskStatsSchema,
  }),
]);
export type AskResult = z.infer<typeof AskResultSchema>;

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

export const ScheduleFireSchema = ScheduleSpecSchema.pick({scheduleId: true});

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

const ProgressPhaseSchema = z.enum(["thinking", "waiting", "finalizing"]);

const ProgressEventSchema = z.object({
  role: z.literal("event"),
  type: z.literal("progress"),
  turnId: z.string(),
  phase: ProgressPhaseSchema,
  message: z.string(),
});

const ToolExecutionStatusSchema = z.enum([
  "succeeded",
  "failed",
  "pending",
  "cancelled",
]);

const ActivityEventSchema = z.object({
  role: z.literal("event"),
  type: z.literal("activity"),
  turnId: z.string(),
  step: z.number().int().positive(),
  message: z.string().trim().min(1),
});

const ToolEventSchema = z.object({
  role: z.literal("event"),
  type: z.literal("tools"),
  turnId: z.string(),
  step: z.number().int().positive(),
  phase: z.enum(["started", "finished"]),
  calls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      summary: z.string().trim().min(1).optional(),
      status: ToolExecutionStatusSchema.optional(),
    }),
  ),
});

// Durable prompt context owned by one Agent. Instructions are authoritative
// user configuration, memories are model-managed data, and guardrails are
// natural-language policies enforced against proposed agent actions.
const MemoryEntrySchema = z.object({
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

export const SetGuardrailsSchema = z.object({
  guardrails: z
    .array(GuardrailSchema)
    .refine(
      (guardrails) =>
        new Set(guardrails.map(({id}) => id)).size === guardrails.length,
      "guardrail ids must be unique",
    )
    .describe(
      "The complete replacement policy list for future Turns. Use an empty list to clear all guardrails.",
    ),
});

export const AgentProfileSchema = z.object({
  instructions: z.string().optional(),
  memories: z.array(MemoryEntrySchema),
  guardrails: z.array(GuardrailSchema),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

// The decision delivered to a waiting tool or policy gate over a signal and
// retained in history after successful delivery.
export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

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
    type: z.literal("stop"),
    turnId: z.string(),
    cause: z.enum(["step_limit", "tool_limit"]),
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
    action: z.literal("fired"),
    turnId: z.string().optional(),
    whenBusy: ScheduleWhenBusySchema,
    routing: z.enum(["start", "queue", "steer", "interrupt"]),
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
  ProgressEventSchema,
  ActivityEventSchema,
  ToolEventSchema,
]);

export const ConversationEntrySchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    text: z.string(),
    delivery: UserMessageDeliverySchema,
  }),
  z.object({
    role: z.literal("assistant"),
    text: z.string(),
    turnId: z.string(),
    status: z.enum(["completed", "interrupted", "stopped", "failed"]),
  }),
  ConversationEventSchema,
]);
export type ConversationEntry = z.infer<typeof ConversationEntrySchema>;

const SequencedConversationEntrySchema = z.object({
  sequence: z.number().int().positive(),
  entry: ConversationEntrySchema,
});

export const HistoryRequestSchema = z.object({
  fromSequence: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(50),
});

const AgentNotificationVersionsSchema = z.object({
  history: z.number().int().nonnegative(),
  profile: z.number().int().nonnegative(),
  approvals: z.number().int().nonnegative(),
  schedules: z.number().int().nonnegative(),
});

export const AgentNotificationSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  versions: AgentNotificationVersionsSchema,
});
export type AgentNotificationSnapshot = z.infer<
  typeof AgentNotificationSnapshotSchema
>;

export const AgentNotificationWatchRequestSchema = z.object({
  afterRevision: z.number().int().nonnegative(),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .default(300)
    .describe(
      "Maximum time to wait for a newer notification before returning the current snapshot.",
    ),
});

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

export const HistoryPageSchema = z.object({
  entries: z.array(SequencedConversationEntrySchema),
  nextSequence: z.number().int().positive(),
});
export type HistoryPage = z.infer<typeof HistoryPageSchema>;

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

// Public input used to resolve one pending approval on the Agent object.
export const ApprovalResolutionSchema = ApprovalDecisionSchema.extend({
  approvalId: z.string().min(1),
});
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

export const ApprovalCancellationSchema = ApprovalRequestSchema.pick({
  approvalId: true,
  turnId: true,
});
export type ApprovalCancellation = z.infer<typeof ApprovalCancellationSchema>;

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

const CompactionRangeShape = {
  baseThrough: z.number().int().nonnegative(),
  through: z.number().int().positive(),
};

export const ConversationCompactionPlanSchema = z.object(CompactionRangeShape);
export type ConversationCompactionPlan = z.infer<
  typeof ConversationCompactionPlanSchema
>;

export const ConversationCompactionResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      ...CompactionRangeShape,
      status: z.literal("completed"),
      summary: z.string().trim().min(1),
    }),
    z.object({
      ...CompactionRangeShape,
      status: z.literal("failed"),
      error: z.string().min(1),
    }),
  ],
);
export type ConversationCompactionResult = z.infer<
  typeof ConversationCompactionResultSchema
>;
