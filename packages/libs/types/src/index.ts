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

const McpServerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe(
    "A stable identifier for one MCP server. Reusing it replaces the existing server.",
  );

export const McpServerAuthSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("none")}),
  z.object({type: z.literal("oauth")}),
  z.object({type: z.literal("bearer")}),
]);
export type McpServerAuth = z.infer<typeof McpServerAuthSchema>;

export const McpProtocolSchema = z.enum(["stateless", "stateful"]);
export type McpProtocol = z.infer<typeof McpProtocolSchema>;

export const McpServerSchema = z.object({
  id: McpServerIdSchema,
  type: z.literal("http"),
  url: z.string().trim().min(1),
  protocol: McpProtocolSchema,
  auth: McpServerAuthSchema,
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
  // Omission preserves ordinary agents' automatic authorized-connector access.
  // Sub-agents pin their creation-time connector grants instead.
  mcpDefault: z.enum(["authorized", "disabled"]).optional(),
  builtin: ToolSelectionSchema,
  dynamic: ToolSelectionSchema,
  // Profile entries are overrides. At turn start User resolves omitted,
  // authorized connections to all; selected/[] is a persistent opt-out.
  mcp: z
    .array(
      z.object({connectionId: McpServerIdSchema, tools: ToolSelectionSchema}),
    )
    .max(32)
    .refine(
      (items) =>
        new Set(items.map((item) => item.connectionId)).size === items.length,
      "Connection IDs must be unique",
    ),
});
export type AgentTools = z.infer<typeof AgentToolsSchema>;
export const DEFAULT_AGENT_TOOLS: AgentTools = {
  builtin: {mode: "all"},
  dynamic: {mode: "selected", names: []},
  mcp: [],
};
export const UserIdentitySchema = z.object({
  userId: z.string().min(1),
  issuer: z.literal("https://accounts.google.com"),
  subject: z.string().min(1),
  displayName: z.string(),
  email: z.string(),
});
export type UserIdentity = z.infer<typeof UserIdentitySchema>;
export const AgentOwnershipSchema = z.object({
  ownerUserId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  parentAgentId: z.string().min(1).optional(),
});
export const UserAgentSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  parentAgentId: z.string().min(1).optional(),
});
export type UserAgent = z.infer<typeof UserAgentSchema>;
export const ToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;
export const ResolvedMcpServerSchema = McpServerSchema.extend({
  revision: z.number().int().positive(),
});
export type ResolvedMcpServer = z.infer<typeof ResolvedMcpServerSchema>;
export const UserConnectionSchema = z.object({
  server: ResolvedMcpServerSchema,
  connected: z.boolean(),
  tools: z.array(ToolDescriptorSchema),
});
export type UserConnection = z.infer<typeof UserConnectionSchema>;
export const MemoryEntrySchema = z.object({
  key: z.string().trim().min(1),
  content: z.string().trim().min(1),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export const UserProfileSchema = z.object({
  identity: UserIdentitySchema,
  agents: z.array(UserAgentSchema),
  connections: z.array(UserConnectionSchema),
  memories: z.array(MemoryEntrySchema),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const McpServerIdRequestSchema = McpServerSchema.pick({id: true});

// Plaintext OAuth shapes are used only in BFF memory. The durable wire shapes
// below carry authenticated ciphertext, never the plaintext SDK values.
export const EncryptedSecretSchema = z
  .string()
  .regex(/^v1:[A-Za-z0-9+/]{38,}={0,2}$/)
  .brand<"EncryptedSecret">();
export type EncryptedSecret = z.infer<typeof EncryptedSecretSchema>;

export const McpOAuthTokensSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    expires_in: z.number().optional(),
    refresh_token: z.string().optional(),
    scope: z.string().optional(),
    id_token: z.string().optional(),
    issuer: z.string().optional(),
  })
  .loose();
export type McpOAuthTokens = z.infer<typeof McpOAuthTokensSchema>;

export const McpOAuthClientInformationSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().optional(),
    client_id_issued_at: z.number().optional(),
    client_secret_expires_at: z.number().optional(),
    issuer: z.string().optional(),
  })
  .loose();
export type McpOAuthClientInformation = z.infer<
  typeof McpOAuthClientInformationSchema
>;

export const McpOAuthDiscoveryStateSchema = z
  .object({
    authorizationServerUrl: z.string().min(1),
    authorizationServerMetadata: z.record(z.string(), z.unknown()).optional(),
    resourceMetadata: z.record(z.string(), z.unknown()).optional(),
    resourceMetadataUrl: z.string().optional(),
  })
  .loose();
export type McpOAuthDiscoveryState = z.infer<
  typeof McpOAuthDiscoveryStateSchema
>;

export const McpOAuthStateSchema = z.object({
  serverId: McpServerIdSchema,
  redirectUrl: z.string().optional(),
  tokens: McpOAuthTokensSchema,
  clientInformation: McpOAuthClientInformationSchema.optional(),
  discoveryState: McpOAuthDiscoveryStateSchema.optional(),
});
export type McpOAuthState = z.infer<typeof McpOAuthStateSchema>;

// The deliberately minimal credential projected into a Turn. Refresh tokens
// and OAuth protocol state remain private to the Agent/BFF boundary.
export const McpTurnCredentialSchema = z.object({
  serverId: McpServerIdSchema,
  encryptedToken: EncryptedSecretSchema,
});
export type McpTurnCredential = z.infer<typeof McpTurnCredentialSchema>;

export const McpStoredOAuthStateSchema = McpTurnCredentialSchema.extend({
  encryptedState: EncryptedSecretSchema,
});
export type McpStoredOAuthState = z.infer<typeof McpStoredOAuthStateSchema>;

// A user-supplied bearer token is durable private Agent state. It shares the
// minimal Turn projection shape but is stored separately from OAuth state.
export const McpBearerCredentialSchema = McpTurnCredentialSchema;
export type McpBearerCredential = z.infer<typeof McpBearerCredentialSchema>;

export const McpAuthorizationReasonSchema = z.enum([
  "missing_credentials",
  "unauthorized",
  "insufficient_scope",
]);

export const McpAuthorizationRequestSchema = z.object({
  authRequestId: z.string().min(1),
  serverId: McpServerIdSchema,
  turnId: z.string().min(1),
  authType: z.enum(["oauth", "bearer"]),
  reason: McpAuthorizationReasonSchema,
  requestedScope: z.string().optional(),
  connectionRevision: z.number().int().positive().optional(),
  rejectedToken: EncryptedSecretSchema.optional(),
  flowId: z.string().optional(),
});
export type McpAuthorizationRequest = z.infer<
  typeof McpAuthorizationRequestSchema
>;

export const McpAuthorizationRequestInputSchema = McpAuthorizationRequestSchema;

export const McpAuthorizationCancellationSchema =
  McpAuthorizationRequestSchema.pick({
    authRequestId: true,
    turnId: true,
  });

export const McpOAuthFlowSchema = z.object({
  redirectUrl: z.string().min(1),
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
  tokens: McpOAuthTokensSchema.optional(),
  clientInformation: McpOAuthClientInformationSchema.optional(),
  discoveryState: McpOAuthDiscoveryStateSchema.optional(),
});
export type McpOAuthFlow = z.infer<typeof McpOAuthFlowSchema>;

export const McpAuthorizationFlowUpdateSchema = z.object({
  expectedFlow: EncryptedSecretSchema.nullable(),
  authRequestId: z.string().min(1),
  flow: EncryptedSecretSchema,
});

export const McpAuthorizationContextRequestSchema = z.object({
  authRequestId: z.string().min(1),
});

export const McpAuthorizationContextSchema = z
  .object({
    request: McpAuthorizationRequestSchema,
    server: McpServerSchema,
    oauthState: McpStoredOAuthStateSchema.optional(),
    flow: EncryptedSecretSchema.optional(),
  })
  .nullable();
export type McpAuthorizationContext = z.infer<
  typeof McpAuthorizationContextSchema
>;

export const McpAuthorizationCompletionSchema = z.object({
  expectedFlow: EncryptedSecretSchema.nullable(),
  authRequestId: z.string().min(1),
  oauthState: McpStoredOAuthStateSchema,
});

export const McpBearerAuthorizationCompletionSchema = z.object({
  authRequestId: z.string().min(1),
  credential: McpTurnCredentialSchema,
});

export const McpAuthorizationResolutionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("authorized"),
    credential: McpTurnCredentialSchema,
  }),
  z.object({status: z.literal("cancelled"), reason: z.string().min(1)}),
]);
export type McpAuthorizationResolution = z.infer<
  typeof McpAuthorizationResolutionSchema
>;

export const McpServerMutationResultSchema = z.discriminatedUnion("accepted", [
  z.object({
    accepted: z.literal(true),
    replaced: z.boolean(),
    server: McpServerSchema,
  }),
  z.object({
    accepted: z.literal(false),
    error: z.string(),
  }),
]);
export type McpServerMutationResult = z.infer<
  typeof McpServerMutationResultSchema
>;

export const McpServerRemovalResultSchema = z.object({
  removed: z.boolean(),
});
export type McpServerRemovalResult = z.infer<
  typeof McpServerRemovalResultSchema
>;

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

/** A source-attributed message entering the Agent's serialized router. */
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

// Keyed updates to shared User memories: model-managed context data, not
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
  guardrails: z.array(GuardrailSchema),
  tools: AgentToolsSchema.default(DEFAULT_AGENT_TOOLS),
  webSearchEnabled: z.boolean().default(true),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentInitializationSchema = AgentOwnershipSchema.extend({
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
      "Optional first task to start asynchronously, or null to create an idle agent.",
    ),
});
export type SubAgentConfig = z.infer<typeof SubAgentConfigSchema>;
export const UserCreateSubAgentSchema = z.object({
  agent: UserAgentSchema.extend({parentAgentId: z.string().min(1)}),
  profile: AgentProfileSchema,
  initialMessage: z.string().nullable(),
});

export const SetWebSearchEnabledSchema = z.object({enabled: z.boolean()});

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
  mcpAuth: z.number().int().nonnegative(),
  schedules: z.number().int().nonnegative(),
});

export const AgentNotificationSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  versions: AgentNotificationVersionsSchema,
});
export type AgentNotificationSnapshot = z.infer<
  typeof AgentNotificationSnapshotSchema
>;

export const UserNotificationSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  profileRevision: z.number().int().nonnegative(),
  agents: z.record(z.string(), AgentNotificationSnapshotSchema),
});
export type UserNotificationSnapshot = z.infer<
  typeof UserNotificationSnapshotSchema
>;

// No caller-selected user identity. These are cache positions, not authority.
export const WorkspaceSyncRequestSchema = z
  .object({
    authorization: z.string().max(48_000).optional(),
    revision: z.number().int().nonnegative().nullable(),
    profileRevision: z.number().int().nonnegative().nullable(),
    agents: z
      .array(
        z
          .object({
            agentId: z.string().min(1).max(256),
            notification: AgentNotificationSnapshotSchema.optional(),
            nextSequence: z.number().int().min(1),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type WorkspaceSyncRequest = z.infer<typeof WorkspaceSyncRequestSchema>;

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
  "mcpAuth",
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
  memories: z.array(MemoryEntrySchema),
  ownerUserId: z.string().min(1),
  mcpServers: z.array(ResolvedMcpServerSchema),
  mcpCredentials: z.array(McpTurnCredentialSchema),
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
