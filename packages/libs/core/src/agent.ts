// Agent is the durable conversation controller. It is a Virtual Object keyed
// by agent id, so its exclusive handlers serialize every decision about the
// active turn, queued messages, persistent profile, approvals, schedules, and
// transcript-reader notifications.
//
// It never runs turn execution itself. `ask` starts or queues work,
// `interrupt` and `steer` resolve signals on the active AgentSession
// invocation, scheduled self-sends re-enter the same routing decisions, and
// `onTurnEnd` accepts that invocation's single high-level outcome.

import {
  type AgentNotificationSnapshot,
  AgentNotificationSnapshotSchema,
  AgentNotificationWatchRequestSchema,
  type AgentProfile,
  AgentProfileSchema,
  type ApprovalRequest,
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  type AskResult,
  AskResultSchema,
  type ConversationEntry,
  GuardrailSchema,
  type ScheduleCancellation,
  type ScheduleCancellationResult,
  ScheduleCancellationResultSchema,
  ScheduleCancellationSchema,
  type ScheduledMessage,
  ScheduledMessageSchema,
  type ScheduleMutation,
  type ScheduleMutationResult,
  ScheduleMutationResultSchema,
  ScheduleMutationSchema,
} from "@restate-agents/types";
import {rpc, TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {approvals} from "./agent-approval.js";
import {notifications} from "./agent-notifications.js";
import {profile} from "./agent-profile.js";
import {schedules} from "./agent-schedules.js";
import {activeTurn} from "./agent-turn.js";
import {
  AgentNotificationSubscriptionSchema,
  AgentNotificationTopicSchema,
  AgentNotificationUnsubscribeSchema,
  type AgentSessionOutcome,
  AgentSessionOutcomeSchema,
  ApprovalCancellationSchema,
  type MemoryUpdate,
  type MemoryUpdateResult,
  MemoryUpdateResultSchema,
  MemoryUpdateSchema,
  ScheduleFireSchema,
} from "./internal-types.js";
import {raceBranches} from "./race.js";

// The agent id is this object's key. Object handlers always have one, but read
// it through here so a missing key is a clear error, not a stray `!`.
function agentKey(): string {
  const key = restate.handlerRequest().key;
  if (!key) {
    throw new TerminalError("Agent handlers require an agent key");
  }
  return key;
}

const DEFAULT_ASK =
  "What is the weather in the top 10 European capitals? Also sleep for 4 minutes.";

const MessageSchema = z.string().trim().min(1);

const AskRequestSchema = z.object({
  message: MessageSchema.default(DEFAULT_ASK),
});

const InterruptRequestSchema = z
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

const SetInstructionsSchema = z.object({
  instructions: z.string().nullable(),
});

const SetGuardrailsSchema = z.object({
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

// Internal coordination handlers are high-volume and their completed
// invocations carry no information worth retaining.
const noRetention = {idempotencyRetention: 0, journalRetention: 0};

export const Agent = restate.object({
  name: "Agent",
  handlers: {
    /**
     * Accepts a user message, starting a Turn while idle or appending it to the
     * next-Turn queue while another Turn is active.
     *
     * Clients use `steer` or `interrupt` when they want to affect active work.
     *
     * @returns The routing decision, relevant Turn ID, and queue statistics.
     */
    ask: restate.schemas(
      {input: AskRequestSchema, output: AskResultSchema},
      function* ({message}): restate.Operation<AskResult> {
        const agentId = agentKey();
        const current = yield* activeTurn.current();
        if (current) {
          const pendingMessages = yield* activeTurn.enqueue({
            role: "user",
            text: message,
            delivery: "queued",
          });
          return {
            decision: "queue",
            turnId: null,
            activeTurnId: current.id,
            stats: {pendingMessages},
          };
        }

        const turnId = yield* startTurn(agentId, [
          {role: "user", text: message, delivery: "turn"},
        ]);
        return {
          decision: "start",
          turnId,
          stats: {pendingMessages: 0},
        };
      },
    ),

    /**
     * Stops the active Turn and optionally queues a replacement user message.
     *
     * The reason guides tool-free finalization. A replacement is still
     * accepted after interruption has begun.
     *
     * @returns Whether an interruption or replacement message was accepted.
     */
    interrupt: restate.schemas(
      {input: InterruptRequestSchema, output: z.boolean()},
      function* ({reason, message}): restate.Operation<boolean> {
        const requested = yield* activeTurn.interrupt(reason);
        if (requested === undefined) {
          return false;
        }

        if (message) {
          yield* activeTurn.enqueue({
            role: "user",
            text: message,
            delivery: "queued",
          });
        }
        if (!requested) {
          return message !== undefined;
        }

        return true;
      },
    ),

    /**
     * Redirects the active Turn with queued messages followed by a new user
     * instruction, without cancelling its current tools.
     *
     * @returns `false` when no Turn can receive steering; the queue is then
     * left untouched.
     */
    steer: restate.schemas(
      {input: MessageSchema, output: z.boolean()},
      function* (message): restate.Operation<boolean> {
        return yield* activeTurn.steer(message);
      },
    ),

    /**
     * Creates or replaces an Agent-owned scheduled message.
     *
     * A Turn-scoped mutation is accepted only from the active Turn; a `null`
     * Turn ID permits direct administration. The durable delayed self-send is
     * identified by its invocation ID.
     */
    scheduleMessage: restate.schemas(
      {input: ScheduleMutationSchema, output: ScheduleMutationResultSchema},
      function* ({
        turnId,
        schedule: spec,
      }: ScheduleMutation): restate.Operation<ScheduleMutationResult> {
        const rejection = yield* scheduleTurnRejection(turnId);
        if (rejection) {
          return {accepted: false, error: rejection};
        }

        const existing = yield* schedules.get(spec.scheduleId);
        if (existing) {
          restate.invocation(existing.timerId).cancel();
        }

        const timer = yield* createScheduleTimer(
          spec.scheduleId,
          spec.delaySeconds,
        );
        const schedule: ScheduledMessage = {
          scheduleId: spec.scheduleId,
          message: spec.message,
          repeatEverySeconds: spec.repeatEverySeconds,
          whenBusy: spec.whenBusy ?? "queue",
          nextRunAt: timer.nextRunAt,
        };
        const stored = yield* schedules.set(schedule, timer.id);
        if ("error" in stored) {
          restate.invocation(timer.id).cancel();
          return {accepted: false, error: stored.error};
        }
        yield* notifications.publish("schedules");

        return {
          accepted: true,
          replaced: stored.replaced,
          schedule,
        };
      },
    ),

    /**
     * Cancels an Agent-owned schedule and its current delayed invocation.
     *
     * Stale timer invocations verify their identity when delivered, making
     * cancellation races harmless.
     */
    cancelSchedule: restate.schemas(
      {
        input: ScheduleCancellationSchema,
        output: ScheduleCancellationResultSchema,
      },
      function* ({
        turnId,
        scheduleId,
      }: ScheduleCancellation): restate.Operation<ScheduleCancellationResult> {
        const rejection = yield* scheduleTurnRejection(turnId);
        if (rejection) {
          return {accepted: false, error: rejection};
        }

        const removed = yield* schedules.remove(scheduleId);
        if (!removed) {
          return {accepted: true, cancelled: false};
        }
        restate.invocation(removed.timerId).cancel();
        yield* notifications.publish("schedules");
        return {accepted: true, cancelled: true};
      },
    ),

    /**
     * Returns the authoritative snapshot of active Agent-owned schedules.
     */
    schedules: restate.schemas(
      {input: z.void(), output: z.array(ScheduledMessageSchema)},
      function* (): restate.Operation<ScheduledMessage[]> {
        return yield* schedules.list();
      },
    ),

    /**
     * Delivers a due scheduled message through normal Agent routing.
     *
     * Only the invocation recorded in schedule state may fire. Repeating
     * schedules install their next timer before routing the current message.
     */
    fireSchedule: restate.schemas(
      {input: ScheduleFireSchema, output: z.void()},
      function* ({scheduleId}): restate.Operation<void> {
        const schedule = yield* schedules.get(scheduleId);
        if (schedule?.timerId !== restate.handlerRequest().id) {
          return;
        }

        if (schedule.repeatEverySeconds === null) {
          yield* schedules.remove(scheduleId);
        } else {
          const timer = yield* createScheduleTimer(
            scheduleId,
            schedule.repeatEverySeconds,
          );
          const stored = yield* schedules.set(
            {...schedule, nextRunAt: timer.nextRunAt},
            timer.id,
          );
          if ("error" in stored) {
            throw new TerminalError(stored.error);
          }
        }
        yield* notifications.publish("schedules");

        yield* deliverScheduledMessage(agentKey(), schedule);
      },
    ),

    /** Publishes an invalidation and forwards it to waiting subscribers. */
    notify: restate.schemas(
      {input: AgentNotificationTopicSchema, output: z.void()},
      function* (topic): restate.Operation<void> {
        yield* notifications.publish(topic);
      },
    ),

    /** Returns the current notification revision and per-area watermarks. */
    notifications: restate.schemas(
      {input: z.void(), output: AgentNotificationSnapshotSchema},
      function* () {
        return yield* notifications.read();
      },
    ),

    /** Waits for any transcript or Agent-state invalidation after a revision. */
    watchNotifications: restate.schemas(
      {
        input: AgentNotificationWatchRequestSchema,
        output: AgentNotificationSnapshotSchema,
      },
      function* (request): restate.Operation<AgentNotificationSnapshot> {
        return yield* waitForNotification(request);
      },
    ),

    /** Registers a caller-owned awakeable for the next notification. */
    subscribeNotifications: restate.schemas(
      {
        input: AgentNotificationSubscriptionSchema,
        output: AgentNotificationSnapshotSchema.nullable(),
      },
      function* (subscription) {
        return yield* notifications.subscribe(subscription);
      },
    ),

    /** Removes a timed-out or cancelled notification subscription. */
    unsubscribeNotifications: restate.schemas(
      {input: AgentNotificationUnsubscribeSchema, output: z.void()},
      function* ({awakeableId}): restate.Operation<void> {
        yield* notifications.unsubscribe(awakeableId);
      },
    ),

    /**
     * Returns the durable instructions, memories, and guardrails that the next
     * Turn will snapshot.
     */
    profile: restate.schemas(
      {input: z.void(), output: AgentProfileSchema},
      function* (): restate.Operation<AgentProfile> {
        return yield* profile.read();
      },
    ),

    /**
     * Replaces persistent user instructions.
     *
     * `null` clears the instructions. Running Turns retain their initial
     * profile snapshot.
     */
    setInstructions: restate.schemas(
      {input: SetInstructionsSchema, output: z.void()},
      function* ({instructions}): restate.Operation<void> {
        profile.setInstructions(instructions);
        yield* notifications.publish("profile");
      },
    ),

    /**
     * Replaces the complete per-Agent guardrail list.
     *
     * Running Turns retain their initial profile snapshot; subsequent Turns
     * enforce the replacement list.
     */
    setGuardrails: restate.schemas(
      {input: SetGuardrailsSchema, output: z.void()},
      function* ({guardrails}): restate.Operation<void> {
        profile.setGuardrails(guardrails);
        yield* notifications.publish("profile");
      },
    ),

    /**
     * Applies one atomic model-requested memory batch.
     *
     * Only the active, non-interrupting Turn may mutate its Agent's memories.
     */
    updateMemory: restate.schemas(
      {input: MemoryUpdateSchema, output: MemoryUpdateResultSchema},
      function* ({
        turnId,
        changes,
      }: MemoryUpdate): restate.Operation<MemoryUpdateResult> {
        const current = yield* activeTurn.current();
        if (current?.id !== turnId || current.interruptReason !== undefined) {
          return {
            applied: false,
            error:
              "memory update rejected because its Turn is no longer active",
          };
        }

        const result = yield* profile.applyMemory(changes);
        if (result.applied) {
          yield* notifications.publish("profile");
        }
        return result;
      },
    ),

    /**
     * Registers a pending human-approval request for an active Turn.
     *
     * Registration is idempotent for an identical request and rejected for a
     * stale, interrupting, or conflicting Turn.
     *
     * @returns Whether the request is registered and can receive a decision.
     */
    requestApproval: restate.schemas(
      {input: ApprovalRequestSchema, output: z.boolean()},
      function* (request: ApprovalRequest): restate.Operation<boolean> {
        const current = yield* activeTurn.current();
        if (
          current?.id !== request.turnId ||
          current.interruptReason !== undefined
        ) {
          return false;
        }
        const registration = yield* approvals.register(request);
        if (registration === "rejected") {
          return false;
        }
        if (registration === "added") {
          yield* notifications.publish("approvals");
        }
        return true;
      },
    ),

    /**
     * Idempotently removes an approval request abandoned by interruption or
     * Turn failure.
     */
    cancelApproval: restate.schemas(
      {input: ApprovalCancellationSchema, output: z.void()},
      function* (request): restate.Operation<void> {
        if (yield* approvals.cancel(request)) {
          yield* notifications.publish("approvals");
        }
      },
    ),

    /**
     * Returns every human-approval request currently awaiting a decision.
     */
    approvals: restate.schemas(
      {input: z.void(), output: z.array(ApprovalRequestSchema)},
      function* (): restate.Operation<ApprovalRequest[]> {
        return yield* approvals.list();
      },
    ),

    /**
     * Resolves a pending approval and signals its waiting tool or policy gate.
     *
     * The decision is accepted only while the originating Turn is active and
     * not interrupting.
     *
     * @returns Whether the decision was delivered.
     */
    resolveApproval: restate.schemas(
      {input: ApprovalResolutionSchema, output: z.boolean()},
      function* (resolution): restate.Operation<boolean> {
        const current = yield* activeTurn.current();
        const request = yield* approvals.resolve(
          resolution,
          current?.interruptReason === undefined ? current?.id : undefined,
        );
        if (!request) {
          return false;
        }
        yield* notifications.publish("approvals");
        return true;
      },
    ),

    /**
     * Reconciles the active Turn's single terminal outcome.
     *
     * The handler retires matching Turn state, clears abandoned approvals,
     * and dispatches queued work. Stale or duplicate outcomes are ignored.
     *
     * @returns The reconciled outcome AgentSession must append, or `null` for
     * a stale or duplicate outcome.
     */
    onTurnEnd: restate.schemas(
      {
        input: AgentSessionOutcomeSchema,
        output: AgentSessionOutcomeSchema.nullable(),
      },
      function* (outcome): restate.Operation<AgentSessionOutcome | null> {
        const finished = yield* activeTurn.finish(outcome);
        if (!finished) {
          return null;
        }
        const cancelledApprovals = yield* approvals.clearTurn(
          finished.outcome.turnId,
        );
        if (cancelledApprovals.length > 0) {
          yield* notifications.publish("approvals");
        }

        const queuedMessages = finished.queuedEntries.filter(
          ({role}) => role === "user",
        ).length;
        if (queuedMessages > 0) {
          yield* startTurn(agentKey(), [
            ...finished.queuedEntries,
            {
              role: "event",
              type: "dispatch",
              queuedMessages,
            },
          ]);
        }
        return finished.outcome;
      },
    ),
  },
  options: {
    enableLazyState: true,
    handlers: {
      // High-volume coordination paths keep no completed-invocation state.
      onTurnEnd: noRetention,
      notify: noRetention,
      notifications: {shared: true, ...noRetention},
      watchNotifications: {
        shared: true,
        inactivityTimeout: {seconds: 1},
        ...noRetention,
      },
      subscribeNotifications: noRetention,
      unsubscribeNotifications: noRetention,
      updateMemory: noRetention,
      scheduleMessage: noRetention,
      cancelSchedule: noRetention,
      fireSchedule: noRetention,
      requestApproval: noRetention,
      cancelApproval: noRetention,
      approvals: {shared: true, ...noRetention},
      schedules: {shared: true, ...noRetention},
      profile: {shared: true, ...noRetention},
    },
  },
});

function* waitForNotification({
  afterRevision,
  timeoutSeconds,
}: {
  afterRevision: number;
  timeoutSeconds: number;
}): restate.Operation<AgentNotificationSnapshot> {
  const changed = restate.awakeable<AgentNotificationSnapshot>();
  const available = yield* restate
    .client(Agent, agentKey())
    .subscribeNotifications({
      afterRevision,
      awakeableId: changed.id,
    });
  if (available) {
    return available;
  }

  try {
    const selected = yield* raceBranches({
      notification: changed.promise,
      timeout: restate.sleep(
        timeoutSeconds * 1_000,
        "notification watch window",
      ),
    });
    if (selected.tag === "notification") {
      return selected.value;
    }

    yield* restate
      .client(Agent, agentKey())
      .unsubscribeNotifications({awakeableId: changed.id});
    return yield* notifications.read();
  } catch (error) {
    yield* restate
      .sendClient(Agent, agentKey())
      .unsubscribeNotifications({awakeableId: changed.id});
    throw error;
  }
}

// Cross-component coordination belongs here: snapshot the Agent profile and
// let AgentSession append the entries that open the turn.
function* startTurn(
  agentId: string,
  entries: ConversationEntry[],
): restate.Operation<string> {
  const agentProfile = yield* profile.read();
  return yield* activeTurn.start(agentId, {...agentProfile, entries});
}

function* createScheduleTimer(
  scheduleId: string,
  delaySeconds: number,
): restate.Operation<{id: string; nextRunAt: number}> {
  const delay = delaySeconds * 1_000;
  const nextRunAt = (yield* restate.date().now()) + delay;
  const timer = yield* restate
    .sendClient(Agent, agentKey())
    .fireSchedule({scheduleId}, rpc.sendOpts({delay}));
  return {id: timer.id, nextRunAt};
}

function* scheduleTurnRejection(
  turnId: string | null,
): restate.Operation<string | undefined> {
  if (turnId === null) {
    return undefined;
  }
  const current = yield* activeTurn.current();
  return current?.id === turnId && current.interruptReason === undefined
    ? undefined
    : "schedule mutation rejected because its Turn is no longer active";
}

function* deliverScheduledMessage(
  agentId: string,
  schedule: ScheduledMessage,
): restate.Operation<void> {
  const current = yield* activeTurn.current();

  if (!current) {
    yield* startTurn(agentId, [
      scheduleFired(schedule, "start"),
      {role: "user", text: schedule.message, delivery: "turn"},
    ]);
    return;
  }

  if (current.interruptReason !== undefined || schedule.whenBusy === "queue") {
    yield* activeTurn.enqueue(scheduleFired(schedule, "queue", current.id), {
      role: "user",
      text: schedule.message,
      delivery: "queued",
    });
    return;
  }

  if (schedule.whenBusy === "steer") {
    const accepted = yield* activeTurn.steer(
      schedule.message,
      scheduleFired(schedule, "steer", current.id),
    );
    if (!accepted) {
      throw new TerminalError("active Turn rejected scheduled steering");
    }
    return;
  }

  yield* activeTurn.enqueue(scheduleFired(schedule, "interrupt", current.id), {
    role: "user",
    text: schedule.message,
    delivery: "queued",
  });
  const requested = yield* activeTurn.interrupt(
    `Scheduled message "${schedule.scheduleId}" became due`,
  );
  if (!requested) {
    throw new TerminalError("active Turn rejected scheduled interruption");
  }
}

function scheduleFired(
  schedule: ScheduledMessage,
  routing: "start" | "queue" | "steer" | "interrupt",
  turnId?: string,
): ConversationEntry {
  return {
    role: "event",
    type: "schedule",
    action: "fired",
    scheduleId: schedule.scheduleId,
    whenBusy: schedule.whenBusy,
    routing,
    ...(turnId ? {turnId} : {}),
  };
}
