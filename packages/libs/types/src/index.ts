// Public wire contracts for the Restate agent runtime. Zod schemas are the
// source of truth shared by the service implementation and external clients.

import {z} from "zod";

export const MessageSchema = z.string().trim().min(1);

export const AskRequestSchema = z.object({
  message: MessageSchema,
});

export const SteerRequestSchema = z.object({message: MessageSchema});

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

const McpServerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe("A unique identifier for one operator-configured MCP server.");

const McpProtocolSchema = z.enum(["stateless", "stateful"]);

export const McpServerSchema = z.object({
  id: McpServerIdSchema,
  type: z.literal("http"),
  url: z.string().trim().min(1),
  protocol: McpProtocolSchema,
  // Name only. The core resolves the secret inside the HTTP effect. The
  // required suffix keeps a typo or copied config from sending an unrelated
  // process secret (OPENAI_API_KEY, RESTATE_AUTH_TOKEN) to an MCP endpoint.
  tokenEnv: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*_MCP_TOKEN$/)
    .optional(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const ToolSelectionSchema = z.discriminatedUnion("mode", [
  z.object({mode: z.literal("all")}),
  z.object({
    mode: z.literal("selected"),
    names: z.array(z.string().min(1)).max(512),
  }),
]);
export type ToolSelection = z.infer<typeof ToolSelectionSchema>;
export const AgentToolsSchema = z.object({
  // Ordinary agents default to the operator-configured connectors.
  // Sub-agents pin their creation-time connector grants instead.
  mcpDefault: z.enum(["configured", "disabled"]).optional(),
  builtin: ToolSelectionSchema,
  dynamic: ToolSelectionSchema,
  // Profile entries override the configured servers; selected/[] disables one.
  mcp: z
    .array(z.object({serverId: McpServerIdSchema, tools: ToolSelectionSchema}))
    .max(32)
    .refine(
      (items) =>
        new Set(items.map((item) => item.serverId)).size === items.length,
      "Connection IDs must be unique",
    ),
});
export type AgentTools = z.infer<typeof AgentToolsSchema>;
export {mcpServerGranted, toolSelected} from "./tool-grants.js";
export const DEFAULT_AGENT_TOOLS: AgentTools = {
  builtin: {mode: "all"},
  dynamic: {mode: "selected", names: []},
  mcp: [],
};
export const AgentMetadataSchema = z.object({
  name: z.string().trim().min(1).max(256),
  parentAgentId: z.string().min(1).optional(),
});
export type AgentMetadata = z.infer<typeof AgentMetadataSchema>;
export const ChildAgentSchema = AgentMetadataSchema.extend({
  agentId: z.string().min(1),
});
export type ChildAgent = z.infer<typeof ChildAgentSchema>;
export const ToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

/** Every tool an agent could be granted: built-ins, discovered Restate handlers and configured MCP servers. */
export const ToolCatalogSchema = z.object({
  builtin: z.array(ToolDescriptorSchema),
  dynamic: z.array(ToolDescriptorSchema),
  mcp: z.array(McpServerSchema),
});
export type ToolCatalog = z.infer<typeof ToolCatalogSchema>;
export const MemoryEntrySchema = z.object({
  key: z.string().trim().min(1),
  content: z.string().trim().min(1),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export const MemoryKeyRequestSchema = MemoryEntrySchema.pick({
  key: true,
}).strict();
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

const DeliveryWhenBusySchema = z
  .enum(["queue", "steer", "interrupt"])
  .describe(
    "How a delivered message enters the conversation when a Turn is active.",
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
  whenBusy: DeliveryWhenBusySchema,
});

export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>;

export const ScheduleIdRequestSchema = ScheduleSpecSchema.pick({
  scheduleId: true,
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

export const AgentDeliverySchema = z.object({
  source: z
    .string()
    .trim()
    .min(1)
    .describe("The external system delivering this message."),
  sourceId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("An optional source-owned identifier for observability."),
  message: MessageSchema,
  whenBusy: DeliveryWhenBusySchema,
  interruptReason: MessageSchema.optional(),
  coalesce: z
    .boolean()
    .optional()
    .describe(
      "Drop this delivery while an earlier one with the same source and sourceId is still queued or part of the active turn.",
    ),
});
export type AgentDelivery = z.infer<typeof AgentDeliverySchema>;

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

// Keyed updates to this agent's memories: model-managed context data, not
// authoritative instructions or policy. Agent configuration remains separate.
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

const GuardrailListSchema = z
  .array(GuardrailSchema)
  .refine(
    (guardrails) =>
      new Set(guardrails.map(({id}) => id)).size === guardrails.length,
    "guardrail ids must be unique",
  );

export const AgentProfileSchema = z.object({
  memories: z.array(MemoryEntrySchema).max(32).default([]),
  instructions: z.string().optional(),
  guardrails: z.array(GuardrailSchema),
  tools: AgentToolsSchema.default(DEFAULT_AGENT_TOOLS),
  webSearchEnabled: z.boolean().default(true),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/**
 * A profile change for subsequent turns. Omitted fields stay unchanged; each
 * given field is replaced whole. `null` instructions clear them.
 */
export const ProfileUpdateSchema = z
  .object({
    instructions: z.string().nullable(),
    guardrails: GuardrailListSchema,
    tools: AgentToolsSchema,
    webSearchEnabled: z.boolean(),
  })
  .partial()
  .strict();
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;

export const AgentInitializationSchema = AgentMetadataSchema.extend({
  profile: AgentProfileSchema.optional(),
});
export const SubAgentConfigSchema = z.object({
  name: z.string().trim().min(1).max(100),
  instructions: z
    .string()
    .trim()
    .min(1)
    .max(16000)
    .nullable()
    .describe(
      "Additional task-specific instructions, or null to inherit only.",
    ),
  guardrails: z
    .array(GuardrailSchema)
    .max(32)
    .nullable()
    .describe(
      "Additional guardrails; inherited guardrails cannot be removed or replaced. Null inherits only.",
    ),
  tools: AgentToolsSchema.nullable().describe(
    "Prefer null to inherit the parent's current access unless the task requires narrower permissions. Otherwise supply a complete, narrower selection. Built-in names (including webSearch) belong only in builtin. Dynamic names use service/handler IDs, MCP names use remote tool names. Use selected with an empty names array for no tools in a category. Omitted MCP connections are disabled.",
  ),
  webSearchEnabled: z
    .boolean()
    .nullable()
    .describe(
      "Null inherits; false disables web search. Cannot enable it if the parent has disabled it.",
    ),
  initialMessage: z
    .string()
    .trim()
    .min(1)
    .max(16000)
    .nullable()
    .describe(
      "First task to run and await. The tool returns the child's answer when it finishes. Null creates an idle agent for later messageSubAgent calls.",
    ),
});
export type SubAgentConfig = z.infer<typeof SubAgentConfigSchema>;

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
    cause: z.literal("step_limit"),
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
    type: z.literal("delivery"),
    source: z.string(),
    sourceId: z.string().optional(),
    turnId: z.string().optional(),
    whenBusy: DeliveryWhenBusySchema,
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
    delegatedBy: z.object({agentId: z.string(), turnId: z.string()}).optional(),
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

export const AgentTurnRequestSchema = AgentProfileSchema.extend({
  // Optional for already-journaled turns; new dispatches always include the name.
  agentName: z.string().optional(),
  mcpServers: z.array(McpServerSchema),
  entries: z.array(ConversationEntrySchema),
});
export type AgentTurnRequest = z.infer<typeof AgentTurnRequestSchema>;

const AgentTurnOutcomeBaseSchema = z.object({
  turnId: z.string(),
  consumedSteering: z.number().int().nonnegative(),
});

export const AgentTurnOutcomeSchema = z.discriminatedUnion("status", [
  AgentTurnOutcomeBaseSchema.extend({
    status: z.literal("completed"),
    response: z.string(),
  }),
  AgentTurnOutcomeBaseSchema.extend({
    status: z.literal("interrupted"),
    reason: z.string(),
    response: z.string().optional(),
  }),
  AgentTurnOutcomeBaseSchema.extend({
    status: z.literal("stopped"),
    cause: z.literal("step_limit"),
    reason: z.string(),
    response: z.string(),
  }),
  AgentTurnOutcomeBaseSchema.extend({
    status: z.literal("failed"),
    error: z.string(),
  }),
]);
export type AgentTurnOutcome = z.infer<typeof AgentTurnOutcomeSchema>;

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
