// Declarative Restate service contracts shared by the implementation and
// typed callers. Keeping these separate prevents browser clients that only
// need wire types and target names from loading the server-side SDK.

import {iface} from "@restatedev/restate-sdk-gen";
import {z} from "zod";

import {
  AgentDeliverySchema,
  AgentInitializationSchema,
  AgentMetadataSchema,
  AgentNotificationSnapshotSchema,
  AgentNotificationSubscriptionSchema,
  AgentNotificationTopicSchema,
  AgentNotificationUnsubscribeSchema,
  AgentNotificationWatchRequestSchema,
  AgentProfileSchema,
  AgentToolsSchema,
  AgentTurnOutcomeSchema,
  AgentTurnRequestSchema,
  ApprovalCancellationSchema,
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  AskRequestSchema,
  AskResultSchema,
  ChildAgentSchema,
  ConversationCompactionPlanSchema,
  ConversationCompactionResultSchema,
  HistoryPageSchema,
  HistoryRequestSchema,
  InterruptRequestSchema,
  MemoryKeyRequestSchema,
  MemoryUpdateResultSchema,
  MemoryUpdateSchema,
  MessageSchema,
  ScheduleCancellationResultSchema,
  ScheduledMessageSchema,
  ScheduleIdRequestSchema,
  ScheduleMutationResultSchema,
  ScheduleSpecSchema,
  SetGuardrailsSchema,
  SetInstructionsSchema,
  SetWebSearchEnabledSchema,
  SubAgentConfigSchema,
  ToolCatalogSchema,
} from "./index.js";
import {AGENT_SERVICE_NAME, AGENT_SESSION_SERVICE_NAME} from "./targets.js";

/** Restate contract implemented by core and consumed by external clients. */
export const AgentDefinition = iface.object(AGENT_SERVICE_NAME, {
  retire: iface.schemas({
    input: z.object({parentAgentId: z.string().optional()}),
    output: z.void(),
  }),
  ask: iface.schemas({input: AskRequestSchema, output: AskResultSchema}),
  interrupt: iface.schemas({
    input: InterruptRequestSchema,
    output: z.boolean(),
  }),
  steer: iface.schemas({input: MessageSchema, output: z.boolean()}),
  deliver: iface.schemas({input: AgentDeliverySchema, output: z.void()}),
  profile: iface.schemas({input: z.void(), output: AgentProfileSchema}),
  setInstructions: iface.schemas({
    input: SetInstructionsSchema,
    output: z.void(),
  }),
  setGuardrails: iface.schemas({input: SetGuardrailsSchema, output: z.void()}),
  setWebSearchEnabled: iface.schemas({
    input: SetWebSearchEnabledSchema,
    output: z.void(),
  }),
  initialize: iface.schemas({
    input: AgentInitializationSchema,
    output: z.void(),
  }),
  // A turn passes its ID and is checked against its live tool grants; a
  // direct caller omits it.
  createSchedule: iface.schemas({
    input: ScheduleSpecSchema.extend({turnId: z.string().min(1).optional()}),
    output: ScheduleMutationResultSchema,
  }),
  cancelSchedule: iface.schemas({
    input: ScheduleIdRequestSchema.extend({
      turnId: z.string().min(1).optional(),
    }),
    output: ScheduleCancellationResultSchema,
  }),
  schedules: iface.schemas({
    input: z.void(),
    output: z.array(ScheduledMessageSchema),
  }),
  fire: iface.schemas({input: ScheduleIdRequestSchema, output: z.void()}),
  publish: iface.schemas({
    input: AgentNotificationTopicSchema,
    output: z.void(),
  }),
  notifications: iface.schemas({
    input: z.void(),
    output: AgentNotificationSnapshotSchema,
  }),
  watch: iface.schemas({
    input: AgentNotificationWatchRequestSchema,
    output: AgentNotificationSnapshotSchema,
  }),
  subscribe: iface.schemas({
    input: AgentNotificationSubscriptionSchema,
    output: AgentNotificationSnapshotSchema.nullable(),
  }),
  unsubscribe: iface.schemas({
    input: AgentNotificationUnsubscribeSchema,
    output: z.void(),
  }),
  createSubAgent: iface.schemas({
    input: SubAgentConfigSchema.extend({
      turnId: z.string().min(1),
      toolCallId: z.string().min(1),
    }),
    output: ChildAgentSchema,
  }),
  startSubAgentTask: iface.schemas({
    input: z.object({
      turnId: z.string().min(1),
      toolCallId: z.string().min(1),
      agentId: z.string().min(1),
      message: z.string().trim().min(1).max(16000),
      source: z.enum(["createSubAgent", "messageSubAgent"]),
    }),
    output: z.object({turnId: z.string()}),
  }),
  finishSubAgentTask: iface.schemas({
    input: z.object({turnId: z.string(), toolCallId: z.string()}),
    output: z.void(),
  }),
  startDelegatedTurn: iface.schemas({
    input: z.object({
      parentAgentId: z.string(),
      parentTurnId: z.string(),
      message: z.string().trim().min(1).max(16000),
    }),
    output: z.object({turnId: z.string()}),
  }),
  interruptDelegatedTurn: iface.schemas({
    input: z.object({
      parentAgentId: z.string(),
      turnId: z.string(),
      reason: z.string(),
    }),
    output: z.void(),
  }),
  deleteSubAgent: iface.schemas({
    input: z.object({turnId: z.string().min(1), agentId: z.string().min(1)}),
    output: z.boolean(),
  }),
  listSubAgents: iface.schemas({
    input: z.object({turnId: z.string().min(1)}),
    output: z.array(ChildAgentSchema),
  }),
  metadata: iface.schemas({
    input: z.void(),
    output: AgentMetadataSchema,
  }),
  children: iface.schemas({input: z.void(), output: z.array(ChildAgentSchema)}),
  deleteMemory: iface.schemas({
    input: MemoryKeyRequestSchema,
    output: z.boolean(),
  }),
  setTools: iface.schemas({input: AgentToolsSchema, output: z.void()}),
  toolCatalog: iface.schemas({input: z.void(), output: ToolCatalogSchema}),
  updateMemory: iface.schemas({
    input: MemoryUpdateSchema,
    output: MemoryUpdateResultSchema,
  }),
  requestApproval: iface.schemas({
    input: ApprovalRequestSchema,
    output: z.boolean(),
  }),
  cancelApproval: iface.schemas({
    input: ApprovalCancellationSchema,
    output: z.void(),
  }),
  approvals: iface.schemas({
    input: z.void(),
    output: z.array(ApprovalRequestSchema),
  }),
  resolveApproval: iface.schemas({
    input: ApprovalResolutionSchema,
    output: z.boolean(),
  }),
  onTurnEnd: iface.schemas({
    input: AgentTurnOutcomeSchema,
    output: AgentTurnOutcomeSchema.nullable(),
  }),
});

/** AgentSession contract implemented by core and consumed by clients. */
export const AgentSessionDefinition = iface.object(AGENT_SESSION_SERVICE_NAME, {
  history: iface.schemas({
    input: HistoryRequestSchema,
    output: HistoryPageSchema,
  }),
  compact: iface.schemas({
    input: ConversationCompactionPlanSchema,
    output: z.void(),
  }),
  applyCompaction: iface.schemas({
    input: ConversationCompactionResultSchema,
    output: z.void(),
  }),
  doTurn: iface.schemas({
    input: AgentTurnRequestSchema,
    output: AgentTurnOutcomeSchema,
  }),
});
