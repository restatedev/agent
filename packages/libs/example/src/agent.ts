// Agent is the durable conversation controller. It is a Virtual Object keyed
// by agent id, so its exclusive handlers serialize every decision about the
// active turn, queued messages, user-facing history, persistent profile, and
// summary checkpoints.
//
// It never runs turn execution itself. `ask` starts or queues work,
// `interrupt` and `steer` resolve signals on the active stateless Turn
// invocation, and `onTurnEnd` accepts that Turn's single high-level outcome.

import {TerminalError} from "@restatedev/restate-sdk";
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
  type SandboxEvent,
  SandboxEventSchema,
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

const AskResultSchema = z.object({
  decision: z.enum(["start", "queue"]),
  turnId: z.string(),
  stats: z.object({
    pendingMessages: z.number().int().nonnegative(),
  }),
});
type AskResult = z.infer<typeof AskResultSchema>;

const HistoryQuerySchema = z.object({
  fromSequence: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(50),
});

const HistoryWatchSchema = z.object({
  fromSequence: z.number().int().positive(),
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

export const Agent = restate.object({
  name: "Agent",
  handlers: {
    // The user entry point. A message starts a turn when the Agent is idle and
    // joins the next-turn queue when one is active. Clients explicitly choose
    // the handlers below when they want to steer or interrupt current work.
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
            turnId: current.id,
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

    // Explicitly stop the active turn. `reason` guides its tool-free
    // finalization; an optional replacement `message` is recorded and queued
    // for the next Turn. A replacement remains accepted when interruption is
    // already in progress. False means the Agent was idle, or it was already
    // interrupting and the request carried no new message.
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

    // Explicitly redirect the active turn. Messages already queued by `ask`
    // are sent first, followed by the new instruction. The transcript records
    // this as an append-only lifecycle event. Returns false when no turn is
    // listening, in which case the queue remains untouched.
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

    // Incremental read of the canonical transcript. The cursor is inclusive:
    // a request from sequence K returns up to `limit` entries starting at K.
    history: restate.schemas(
      {input: HistoryQuerySchema, output: HistoryPageSchema},
      function* ({fromSequence, limit}): restate.Operation<HistoryPage> {
        return yield* history.page(fromSequence, limit);
      },
    ),

    // Register a caller-owned awakeable for the next readable history entry.
    // The exclusive cursor check prevents a lost append between an empty read
    // and registration. The caller waits outside this virtual object.
    watchHistory: restate.schemas(
      {input: HistoryWatchSchema, output: z.void()},
      function* ({fromSequence, awakeableId}): restate.Operation<void> {
        yield* history.watch(fromSequence, awakeableId);
      },
    ),

    // Read the durable instructions, model-managed memories, and policy
    // guardrails that will be snapshotted into the next Turn.
    profile: restate.schemas(
      {input: z.void(), output: AgentProfileSchema},
      function* (): restate.Operation<AgentProfile> {
        return yield* profile.read();
      },
    ),

    // Replace the user-authored persistent instructions. Null clears them.
    // Running Turns retain the snapshot with which they started.
    setInstructions: restate.schemas(
      {input: SetInstructionsSchema, output: z.void()},
      function* ({instructions}): restate.Operation<void> {
        profile.setInstructions(instructions);
      },
    ),

    // Replace the per-Agent natural-language policies. Running Turns retain
    // their current snapshot; subsequent Turns enforce the new list.
    setGuardrails: restate.schemas(
      {input: SetGuardrailsSchema, output: z.void()},
      function* ({guardrails}): restate.Operation<void> {
        profile.setGuardrails(guardrails);
      },
    ),

    // Apply one atomic memory batch requested by the model. Only the active,
    // non-interrupting Turn may mutate its Agent's memories.
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

    // Internal one-way status path used by the active Turn. Progress is an
    // ordered lifecycle event in the transcript; late reports are ignored.
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

    // Structured user-facing execution detail from an active Turn. A batch
    // keeps model-authored activity and the tool-start event adjacent.
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

    // Successful sandbox lifecycle transitions are semantic transcript events.
    // Provisioning must still belong to the active Turn; suspension may arrive
    // after that Turn has already completed.
    reportSandbox: restate.schemas(
      {input: SandboxEventSchema, output: z.void()},
      function* (event: SandboxEvent): restate.Operation<void> {
        if (event.status === "provisioned") {
          const current = yield* activeTurn.current();
          if (current?.id !== event.turnId) {
            return;
          }
        }
        yield* history.append({
          role: "event",
          type: "sandbox",
          ...event,
        });
      },
    ),

    // Internal registration path used by the humanApproval tool and runtime
    // guardrails. The request is accepted only while its Turn is still active.
    requestApproval: restate.schemas(
      {input: ApprovalRequestSchema, output: z.boolean()},
      function* (request: ApprovalRequest): restate.Operation<boolean> {
        const current = yield* activeTurn.current();
        if (current?.id !== request.turnId || current.interrupting) {
          return false;
        }
        return yield* approvals.register(request);
      },
    ),

    // Internal, idempotent cleanup when interruption or turn failure abandons
    // a tool or policy gate that was waiting for approval.
    cancelApproval: restate.schemas(
      {input: ApprovalCancellationSchema, output: z.void()},
      function* (request): restate.Operation<void> {
        yield* approvals.cancel(request);
      },
    ),

    // Read-only pending approvals for a UI or human operator.
    approvals: restate.schemas(
      {input: z.void(), output: z.array(ApprovalRequestSchema)},
      function* (): restate.Operation<ApprovalRequest[]> {
        return yield* approvals.list();
      },
    ),

    // Resolve one pending request and deliver the decision to the waiting tool
    // or policy gate as a signal on its Turn invocation.
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

    // The active Turn sends exactly one structured outcome here. Verify it
    // belongs to the active turn, append its user-facing result, retire the
    // turn, and dispatch anything still queued. An explicit interrupt event is
    // already in history; external cancellation gets one here. A graceful
    // interruption can additionally produce an assistant finalization.
    // Detailed execution activity is reported separately while the Turn runs;
    // this path records only its terminal result.
    onTurnEnd: restate.schemas(
      {input: TurnOutcomeSchema, output: z.void()},
      function* (outcome): restate.Operation<void> {
        const finished = yield* activeTurn.finish(outcome);
        if (!finished) {
          return;
        }
        yield* approvals.clearTurn(outcome.turnId);

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

    // Read and summarize one reserved history prefix without blocking the
    // Agent's exclusive conversation handlers, then self-send the result to
    // the exclusive checkpoint application path.
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

    // The shared compaction handler returns a derived checkpoint here. History
    // validates the reserved prefix before replacing the previous summary.
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
      watchHistory: noRetention,
      updateMemory: noRetention,
      reportProgress: noRetention,
      reportExecution: noRetention,
      reportSandbox: noRetention,
      requestApproval: noRetention,
      cancelApproval: noRetention,
      applyCompaction: noRetention,
      approvals: {shared: true, ...noRetention},
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
