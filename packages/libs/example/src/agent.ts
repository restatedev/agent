// Agent is the durable conversation controller. It is a Virtual Object keyed
// by agent id, so its exclusive handlers serialize every decision about the
// active turn, queued messages, user-facing history, persistent profile, and
// scheduled messages and summary checkpoints.
//
// It never runs turn execution itself. `ask` starts or queues work,
// `interrupt` and `steer` resolve signals on the active stateless Turn
// invocation, scheduled self-sends re-enter the same routing decisions, and
// `onTurnEnd` accepts that Turn's single high-level outcome.

import {rpc, TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {approvals} from "./agent-approval.js";
import {
  type ConversationCompactionPlan,
  ConversationCompactionPlanSchema,
  type ConversationCompactionResult,
  ConversationCompactionResultSchema,
  history,
} from "./agent-history.js";
import {profile} from "./agent-profile.js";
import {schedules} from "./agent-schedules.js";
import {activeTurn} from "./agent-turn.js";
import {compactConversation} from "./conversation-compactor.js";
import {
  type AgentProfile,
  AgentProfileSchema,
  ApprovalCancellationSchema,
  type ApprovalRequest,
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  type ConversationEntry,
  type ExecutionReport,
  ExecutionReportSchema,
  GuardrailSchema,
  type HistoryPage,
  HistoryPageSchema,
  type MemoryUpdate,
  type MemoryUpdateResult,
  MemoryUpdateResultSchema,
  MemoryUpdateSchema,
  type ProgressReport,
  ProgressReportSchema,
  type ScheduleCancellation,
  type ScheduleCancellationResult,
  ScheduleCancellationResultSchema,
  ScheduleCancellationSchema,
  type ScheduledMessage,
  ScheduledMessageSchema,
  ScheduleFireSchema,
  type ScheduleMutation,
  type ScheduleMutationResult,
  ScheduleMutationResultSchema,
  ScheduleMutationSchema,
  TurnOutcomeSchema,
} from "./types.js";

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

const AskStatsSchema = z.object({
  pendingMessages: z.number().int().nonnegative(),
});

const AskResultSchema = z.discriminatedUnion("decision", [
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

const HistoryQuerySchema = z.object({
  fromSequence: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(50),
});

const WatchHistorySchema = z.object({
  fromSequence: z.number().int().positive(),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .default(300)
    .describe(
      "How long this wait window may park before returning false, up to the five-minute safety ceiling. Callers loop; the window bounds server-side residency, not the overall wait.",
    ),
});

const RegisterHistoryWatcherSchema = z.object({
  fromSequence: z.number().int().positive(),
  awakeableId: z.string().min(1),
});

const UnregisterHistoryWatcherSchema = z.object({
  awakeableId: z.string().min(1),
});

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

function executionEntry(report: ExecutionReport): ConversationEntry {
  return {role: "event", ...report};
}

function approvalCancelledEntry({
  approvalId,
  turnId,
}: ApprovalRequest): ConversationEntry {
  return {role: "event", type: "approval_cancelled", approvalId, turnId};
}

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
          const pendingMessages = yield* activeTurn.enqueue(message);
          yield* history.append({
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

        yield* history.append({role: "user", text: message, delivery: "turn"});
        const turnId = yield* startTurn(agentId);
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
        const interruption = yield* activeTurn.interrupt(reason);
        if (!interruption) {
          return false;
        }

        if (message) {
          yield* activeTurn.enqueue(message);
          yield* history.append({
            role: "user",
            text: message,
            delivery: "queued",
          });
        }
        if (!interruption.requested) {
          return message !== undefined;
        }

        yield* history.append({
          role: "event",
          type: "interrupt",
          turnId: interruption.turnId,
          reason,
        });
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
        const steering = yield* activeTurn.steer(message);
        if (!steering) {
          return false;
        }
        yield* history.append(
          {
            role: "user",
            text: steering.message,
            delivery: "steer",
          },
          {
            role: "event",
            type: "steer",
            turnId: steering.turnId,
            queuedMessages: steering.queued.length,
          },
        );
        return true;
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

        yield* history.append({
          role: "event",
          type: "schedule",
          action: stored.replaced ? "updated" : "created",
          scheduleId: schedule.scheduleId,
          ...(turnId ? {turnId} : {}),
          nextRunAt: timer.nextRunAt,
          whenBusy: schedule.whenBusy,
        });
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
        yield* history.append({
          role: "event",
          type: "schedule",
          action: "cancelled",
          scheduleId,
          ...(turnId ? {turnId} : {}),
        });
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

        yield* deliverScheduledMessage(agentKey(), schedule);
      },
    ),

    /**
     * Reads a page from the canonical transcript using an inclusive sequence
     * cursor.
     *
     * @returns Up to the requested limit and the next unread sequence.
     */
    history: restate.schemas(
      {input: HistoryQuerySchema, output: HistoryPageSchema},
      function* ({fromSequence, limit}): restate.Operation<HistoryPage> {
        return yield* history.page(fromSequence, limit);
      },
    ),

    /**
     * Waits until a transcript cursor is readable or the wait window elapses.
     *
     * Callers re-read `history` and repeat as needed. The shared-state fast
     * path may lag slightly, but the exclusive registration path re-checks the
     * cursor and prevents missed entries.
     *
     * @returns Whether the requested sequence is ready to read.
     */
    watchHistory: restate.schemas(
      {input: WatchHistorySchema, output: z.boolean()},
      function* ({fromSequence, timeoutSeconds}): restate.Operation<boolean> {
        if (yield* history.isReadable(fromSequence)) {
          return true;
        }

        const changed = restate.awakeable<void>();
        yield* restate.client(Agent, agentKey()).registerHistoryWatcher({
          fromSequence,
          awakeableId: changed.id,
        });
        const selected = yield* restate.select({
          readable: changed.promise,
          timeout: restate.sleep(timeoutSeconds * 1_000, "watch window"),
        });
        yield* selected.future;
        if (selected.tag === "timeout") {
          // Withdraw the registration so idle repeat watchers do not
          // accumulate in Agent state.
          yield* restate
            .sendClient(Agent, agentKey())
            .unregisterHistoryWatcher({awakeableId: changed.id});
          return false;
        }
        return true;
      },
    ),

    /**
     * Registers a caller-owned awakeable for a history cursor.
     *
     * The exclusive cursor re-check closes the race between an empty shared
     * read and watcher registration.
     */
    registerHistoryWatcher: restate.schemas(
      {input: RegisterHistoryWatcherSchema, output: z.void()},
      function* ({fromSequence, awakeableId}): restate.Operation<void> {
        yield* history.watch(fromSequence, awakeableId);
      },
    ),

    /**
     * Removes a caller-owned history watcher after its wait window expires.
     */
    unregisterHistoryWatcher: restate.schemas(
      {input: UnregisterHistoryWatcherSchema, output: z.void()},
      function* ({awakeableId}): restate.Operation<void> {
        yield* history.unwatch(awakeableId);
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
     * Replaces persistent user instructions and records the profile change.
     *
     * `null` clears the instructions. Running Turns retain their initial
     * profile snapshot.
     */
    setInstructions: restate.schemas(
      {input: SetInstructionsSchema, output: z.void()},
      function* ({instructions}): restate.Operation<void> {
        profile.setInstructions(instructions);
        yield* history.append({
          role: "event",
          type: "profile",
          change: {
            field: "instructions",
            configured: Boolean(instructions?.trim()),
          },
        });
      },
    ),

    /**
     * Replaces the complete per-Agent guardrail list and records its IDs.
     *
     * Running Turns retain their initial profile snapshot; subsequent Turns
     * enforce the replacement list.
     */
    setGuardrails: restate.schemas(
      {input: SetGuardrailsSchema, output: z.void()},
      function* ({guardrails}): restate.Operation<void> {
        profile.setGuardrails(guardrails);
        yield* history.append({
          role: "event",
          type: "profile",
          change: {
            field: "guardrails",
            ids: guardrails.map(({id}) => id),
          },
        });
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
        if (current?.id !== turnId || current.interrupting) {
          return {
            applied: false,
            error:
              "memory update rejected because its Turn is no longer active",
          };
        }

        const result = yield* profile.applyMemory(changes);
        if (result.applied) {
          yield* history.append({
            role: "event",
            type: "memory",
            turnId,
            changes: changes.map(({operation, key}) => ({operation, key})),
          });
        }
        return result;
      },
    ),

    /**
     * Appends a semantic progress event from the active Turn.
     *
     * This is a one-way coordination path; reports from stale Turns are
     * ignored.
     */
    reportProgress: restate.schemas(
      {input: ProgressReportSchema, output: z.void()},
      function* (report: ProgressReport): restate.Operation<void> {
        const current = yield* activeTurn.current();
        if (current?.id === report.turnId) {
          yield* history.append({
            role: "event",
            type: "progress",
            ...report,
          });
        }
      },
    ),

    /**
     * Appends structured activity or tool lifecycle reports from the active
     * Turn.
     *
     * Reports in one batch remain adjacent; batches containing a stale Turn
     * ID are ignored.
     */
    reportExecution: restate.schemas(
      {input: z.array(ExecutionReportSchema).min(1), output: z.void()},
      function* (reports: ExecutionReport[]): restate.Operation<void> {
        const current = yield* activeTurn.current();
        if (reports.some(({turnId}) => turnId !== current?.id)) {
          return;
        }
        yield* history.append(...reports.map(executionEntry));
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
        if (current?.id !== request.turnId || current.interrupting) {
          return false;
        }
        const registration = yield* approvals.register(request);
        if (registration === "rejected") {
          return false;
        }
        if (registration === "added") {
          yield* history.append({
            role: "event",
            type: "approval_request",
            ...request,
          });
        }
        return true;
      },
    ),

    /**
     * Idempotently removes an approval request abandoned by interruption or
     * Turn failure and records its cancellation when present.
     */
    cancelApproval: restate.schemas(
      {input: ApprovalCancellationSchema, output: z.void()},
      function* (request): restate.Operation<void> {
        const cancelled = yield* approvals.cancel(request);
        if (cancelled) {
          yield* history.append(approvalCancelledEntry(cancelled));
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
     * not interrupting, then recorded in the canonical transcript.
     *
     * @returns Whether the decision was delivered.
     */
    resolveApproval: restate.schemas(
      {input: ApprovalResolutionSchema, output: z.boolean()},
      function* (resolution): restate.Operation<boolean> {
        const current = yield* activeTurn.current();
        const request = yield* approvals.resolve(
          resolution,
          current?.interrupting ? undefined : current?.id,
        );
        if (!request) {
          return false;
        }
        yield* history.append({
          role: "event",
          type: "approval",
          approvalId: request.approvalId,
          turnId: request.turnId,
          question: request.question,
          ...(request.guardrailId ? {guardrailId: request.guardrailId} : {}),
          decision: resolution.decision,
          ...(resolution.reason ? {reason: resolution.reason} : {}),
        });
        return true;
      },
    ),

    /**
     * Reconciles the active Turn's single terminal outcome.
     *
     * The handler retires matching Turn state, clears abandoned approvals,
     * appends terminal transcript entries, dispatches queued work, and starts
     * compaction when eligible. Stale or duplicate outcomes are ignored.
     */
    onTurnEnd: restate.schemas(
      {input: TurnOutcomeSchema, output: z.void()},
      function* (outcome): restate.Operation<void> {
        const finished = yield* activeTurn.finish(outcome);
        if (!finished) {
          return;
        }
        const cancelledApprovals = yield* approvals.clearTurn(outcome.turnId);
        yield* history.append(
          ...cancelledApprovals.map(approvalCancelledEntry),
        );

        if (outcome.status === "interrupted") {
          if (!finished.interruptionRequested) {
            yield* history.append({
              role: "event",
              type: "interrupt",
              turnId: outcome.turnId,
              reason: outcome.reason,
            });
          }
          if (outcome.response) {
            yield* history.append({
              role: "assistant",
              text: outcome.response,
              turnId: outcome.turnId,
              status: "interrupted",
            });
          }
        } else if (outcome.status === "stopped") {
          yield* history.append(
            {
              role: "event",
              type: "stop",
              turnId: outcome.turnId,
              cause: outcome.cause,
              reason: outcome.reason,
            },
            {
              role: "assistant",
              text: outcome.response,
              turnId: outcome.turnId,
              status: "stopped",
            },
          );
        } else {
          yield* history.append({
            role: "assistant",
            text:
              outcome.status === "completed" ? outcome.response : outcome.error,
            turnId: outcome.turnId,
            status: outcome.status,
          });
        }
        const agentId = agentKey();
        const queuedMessages =
          finished.missedSteeringMessages + finished.pendingMessages;
        if (queuedMessages > 0) {
          // Keep queued messages and their activation boundary in the same
          // compaction prefix.
          yield* startTurn(agentId, queuedMessages);
        }

        const plan = yield* history.beginCompaction();
        if (plan) {
          yield* restate.sendClient(Agent, agentId).compact(plan);
        }
      },
    ),

    /**
     * Summarizes one reserved transcript prefix from a shared handler.
     *
     * The derived result is sent to the exclusive `applyCompaction` path so
     * conversation handlers are not blocked by model inference.
     */
    compact: restate.schemas(
      {input: ConversationCompactionPlanSchema, output: z.void()},
      function* (plan: ConversationCompactionPlan): restate.Operation<void> {
        const input = yield* history.readCompaction(plan);
        if (!input) {
          return;
        }
        const result = yield* compactConversation(input);
        yield* restate.sendClient(Agent, agentKey()).applyCompaction(result);
      },
    ),

    /**
     * Applies a derived summary only when it matches the currently reserved
     * transcript prefix.
     */
    applyCompaction: restate.schemas(
      {input: ConversationCompactionResultSchema, output: z.void()},
      function* (
        result: ConversationCompactionResult,
      ): restate.Operation<void> {
        yield* history.finishCompaction(result);
      },
    ),
  },
  options: {
    enableLazyState: true,
    handlers: {
      // Coordination paths keep no completed-invocation state; the user-facing
      // conversation handlers retain the server defaults.
      onTurnEnd: noRetention,
      watchHistory: {
        shared: true,
        inactivityTimeout: {seconds: 1},
        ...noRetention,
      },
      registerHistoryWatcher: noRetention,
      unregisterHistoryWatcher: noRetention,
      updateMemory: noRetention,
      scheduleMessage: noRetention,
      cancelSchedule: noRetention,
      fireSchedule: noRetention,
      reportProgress: noRetention,
      reportExecution: noRetention,
      requestApproval: noRetention,
      cancelApproval: noRetention,
      applyCompaction: noRetention,
      approvals: {shared: true, ...noRetention},
      schedules: {shared: true, ...noRetention},
      history: {shared: true, ...noRetention},
      profile: {shared: true, ...noRetention},
      compact: {shared: true, ...noRetention},
    },
  },
});

// Cross-component coordination belongs here: mark queued messages as active,
// prepare the complete transcript, then let activeTurn own the invocation.
function* startTurn(
  agentId: string,
  queuedMessages = 0,
): restate.Operation<string> {
  if (queuedMessages > 0) {
    yield* history.append({
      role: "event",
      type: "dispatch",
      queuedMessages,
    });
  }
  const context = yield* history.context();
  const agentProfile = yield* profile.read();
  return yield* activeTurn.start({
    agentId,
    ...agentProfile,
    summary: context.summary,
    history: context.entries,
  });
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
  return current?.id === turnId && !current.interrupting
    ? undefined
    : "schedule mutation rejected because its Turn is no longer active";
}

function* deliverScheduledMessage(
  agentId: string,
  schedule: ScheduledMessage,
): restate.Operation<void> {
  const current = yield* activeTurn.current();
  const event = {
    role: "event" as const,
    type: "schedule" as const,
    action: "fired" as const,
    scheduleId: schedule.scheduleId,
    whenBusy: schedule.whenBusy,
  };

  if (!current) {
    yield* history.append(
      {...event, routing: "start"},
      {role: "user", text: schedule.message, delivery: "turn"},
    );
    yield* startTurn(agentId);
    return;
  }

  if (current.interrupting || schedule.whenBusy === "queue") {
    yield* activeTurn.enqueue(schedule.message);
    yield* history.append(
      {...event, routing: "queue"},
      {role: "user", text: schedule.message, delivery: "queued"},
    );
    return;
  }

  if (schedule.whenBusy === "steer") {
    const steering = yield* activeTurn.steer(schedule.message);
    if (!steering) {
      throw new TerminalError("active Turn rejected scheduled steering");
    }
    yield* history.append(
      {...event, routing: "steer"},
      {role: "user", text: schedule.message, delivery: "steer"},
      {
        role: "event",
        type: "steer",
        turnId: steering.turnId,
        queuedMessages: steering.queued.length,
      },
    );
    return;
  }

  yield* activeTurn.enqueue(schedule.message);
  const interruption = yield* activeTurn.interrupt(
    `Scheduled message "${schedule.scheduleId}" became due`,
  );
  if (!interruption?.requested) {
    throw new TerminalError("active Turn rejected scheduled interruption");
  }
  yield* history.append(
    {...event, routing: "interrupt"},
    {role: "user", text: schedule.message, delivery: "queued"},
    {
      role: "event",
      type: "interrupt",
      turnId: interruption.turnId,
      reason: `Scheduled message "${schedule.scheduleId}" became due`,
    },
  );
}
