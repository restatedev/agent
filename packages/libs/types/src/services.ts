// Declarative Restate service contracts shared by the implementation and
// typed callers. Keeping these separate prevents browser clients that only
// need wire types and target names from loading the server-side SDK.

import {iface} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {
  AgentDeliverySchema,
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
  ScheduledMessageSchema,
  ScheduleIdRequestSchema,
  ScheduleMutationResultSchema,
  ScheduleSpecSchema,
  SetGuardrailsSchema,
  SetInstructionsSchema,
} from "./index.js";
import {
  AGENT_NOTIFICATIONS_SERVICE_NAME,
  AGENT_SCHEDULER_SERVICE_NAME,
  AGENT_SERVICE_NAME,
  AGENT_SESSION_SERVICE_NAME,
} from "./targets.js";

/** Restate contract implemented by core and consumed by external clients. */
export const AgentDefinition = iface.object(AGENT_SERVICE_NAME, {
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

/** Per-Agent invalidation stream consumed by transcript and state watchers. */
export const AgentNotificationsDefinition = iface.object(
  AGENT_NOTIFICATIONS_SERVICE_NAME,
  {
    publish: iface.schemas({
      input: AgentNotificationTopicSchema,
      output: z.void(),
    }),
    snapshot: iface.schemas({
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
  },
);

/** Per-Agent durable schedule registry and timer lifecycle. */
export const AgentSchedulerDefinition = iface.object(
  AGENT_SCHEDULER_SERVICE_NAME,
  {
    upsert: iface.schemas({
      input: ScheduleSpecSchema,
      output: ScheduleMutationResultSchema,
    }),
    cancel: iface.schemas({
      input: ScheduleIdRequestSchema,
      output: ScheduleCancellationResultSchema,
    }),
    list: iface.schemas({
      input: z.void(),
      output: z.array(ScheduledMessageSchema),
    }),
    fire: iface.schemas({input: ScheduleIdRequestSchema, output: z.void()}),
  },
);

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
