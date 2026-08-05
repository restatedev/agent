// Declarative Restate service contracts shared by the implementation and
// typed callers. Keeping these separate prevents browser clients that only
// need wire types and target names from loading the server-side SDK.

import {iface} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  AgentNotificationSnapshotSchema,
  AgentNotificationSubscriptionSchema,
  AgentNotificationTopicSchema,
  AgentNotificationUnsubscribeSchema,
  AgentNotificationWatchRequestSchema,
  AgentProfileSchema,
  AgentTurnOutcomeSchema,
  AgentTurnRequestSchema,
  ApprovalCancellationSchema,
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  AskRequestSchema,
  AskResultSchema,
  ConversationCompactionPlanSchema,
  ConversationCompactionResultSchema,
  HistoryPageSchema,
  HistoryRequestSchema,
  InterruptRequestSchema,
  MemoryUpdateResultSchema,
  MemoryUpdateSchema,
  MessageSchema,
  ScheduleCancellationResultSchema,
  ScheduleCancellationSchema,
  ScheduledMessageSchema,
  ScheduleFireSchema,
  ScheduleMutationResultSchema,
  ScheduleMutationSchema,
  SetGuardrailsSchema,
  SetInstructionsSchema,
} from "./index.js";
import {AGENT_SERVICE_NAME, AGENT_SESSION_SERVICE_NAME} from "./targets.js";

/** Restate contract implemented by core and consumed by external clients. */
export const AgentDefinition = iface.object(AGENT_SERVICE_NAME, {
  ask: iface.schemas({input: AskRequestSchema, output: AskResultSchema}),
  interrupt: iface.schemas({
    input: InterruptRequestSchema,
    output: z.boolean(),
  }),
  steer: iface.schemas({input: MessageSchema, output: z.boolean()}),
  scheduleMessage: iface.schemas({
    input: ScheduleMutationSchema,
    output: ScheduleMutationResultSchema,
  }),
  cancelSchedule: iface.schemas({
    input: ScheduleCancellationSchema,
    output: ScheduleCancellationResultSchema,
  }),
  schedules: iface.schemas({
    input: z.void(),
    output: z.array(ScheduledMessageSchema),
  }),
  fireSchedule: iface.schemas({input: ScheduleFireSchema, output: z.void()}),
  notify: iface.schemas({
    input: AgentNotificationTopicSchema,
    output: z.void(),
  }),
  notifications: iface.schemas({
    input: z.void(),
    output: AgentNotificationSnapshotSchema,
  }),
  watchNotifications: iface.schemas({
    input: AgentNotificationWatchRequestSchema,
    output: AgentNotificationSnapshotSchema,
  }),
  subscribeNotifications: iface.schemas({
    input: AgentNotificationSubscriptionSchema,
    output: AgentNotificationSnapshotSchema.nullable(),
  }),
  unsubscribeNotifications: iface.schemas({
    input: AgentNotificationUnsubscribeSchema,
    output: z.void(),
  }),
  profile: iface.schemas({input: z.void(), output: AgentProfileSchema}),
  setInstructions: iface.schemas({
    input: SetInstructionsSchema,
    output: z.void(),
  }),
  setGuardrails: iface.schemas({input: SetGuardrailsSchema, output: z.void()}),
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
  doTurn: iface.schemas({input: AgentTurnRequestSchema, output: z.void()}),
});
