// Agent is the durable conversation controller. It is a Virtual Object keyed
// by agent id, so its exclusive handlers serialize every decision about the
// active turn, queued messages, user-facing history, and summary checkpoints.
//
// It never runs the agent loop itself. `ask` starts or queues work,
// `interrupt` and `steer` resolve signals on the active stateless Turn
// invocation, and `append` accepts that Turn's single high-level outcome.

import {TerminalError} from "@restatedev/restate-sdk";
import {
  handlerRequest,
  type Operation,
  object,
  schemas,
  sendClient,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {approvals} from "./agent-approval.js";
import {
  type ConversationCompactionPlan,
  type ConversationCompactionResult,
  history,
} from "./agent-history.js";
import {progress as progressLog} from "./agent-progress.js";
import {activeTurn} from "./agent-turn.js";
import {compactConversation} from "./conversation-compactor.js";
import {
  ApprovalCancellationSchema,
  type ApprovalRequest,
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  type ConversationEntry,
  ConversationEntrySchema,
  type ProgressEvent,
  ProgressEventSchema,
  type ProgressReport,
  ProgressReportSchema,
  TurnOutcomeSchema,
} from "./types.js";

// The agent id is this object's key. Object handlers always have one, but read
// it through here so a missing key is a clear error, not a stray `!`.
function agentKey(): string {
  const key = handlerRequest().key;
  if (!key) {
    throw new TerminalError("Agent handlers require an agent key");
  }
  return key;
}

const DEFAULT_ASK =
  "What is the weather in the top 10 European capitals? Also sleep for 4 minutes.";

const AskRequestSchema = z.object({
  message: z.string().default(DEFAULT_ASK),
});

const AskResultSchema = z.object({
  decision: z.enum(["start", "queue"]),
  turnId: z.string(),
  stats: z.object({
    pendingMessages: z.number().int().nonnegative(),
  }),
});
type AskResult = z.infer<typeof AskResultSchema>;

const ProgressQuerySchema = z.object({
  afterSequence: z.number().int().nonnegative().default(0),
});

export const Agent = object({
  name: "Agent",
  handlers: {
    // The user entry point. A message starts a turn when the Agent is idle and
    // joins the next-turn queue when one is active. Clients explicitly choose
    // the handlers below when they want to steer or interrupt current work.
    ask: schemas(
      {input: AskRequestSchema, output: AskResultSchema},
      function* ({message}): Operation<AskResult> {
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

    // Explicitly stop the active turn; the input is the reason. No intent
    // guessing — this is the API a stop button calls. Returns whether the stop
    // was requested; false means there was nothing to stop (idle, or already
    // winding down from an earlier interrupt) and nothing happened.
    interrupt: schemas(
      {input: z.string(), output: z.boolean()},
      function* (reason): Operation<boolean> {
        const turnId = yield* activeTurn.interrupt(reason);
        if (!turnId) {
          return false;
        }
        yield* history.append({
          role: "event",
          type: "interrupt",
          turnId,
          reason,
        });
        return true;
      },
    ),

    // Explicitly redirect the active turn. Messages already queued by `ask`
    // are promoted first, followed by the new instruction. Returns false when
    // no turn is listening, in which case the queue remains untouched.
    steer: schemas(
      {input: z.string(), output: z.boolean()},
      function* (message): Operation<boolean> {
        const steering = yield* activeTurn.steer(message);
        if (!steering) {
          return false;
        }
        yield* history.promoteLatestQueued(steering.queued.length);
        yield* history.append({
          role: "user",
          text: steering.message,
          delivery: "steer",
        });
        return true;
      },
    ),

    // Read-only view of the canonical transcript. Queued messages are recorded
    // by ask at acceptance time, so no second pending-state view is merged in.
    history: schemas(
      {input: z.void(), output: z.array(ConversationEntrySchema)},
      function* (): Operation<ConversationEntry[]> {
        return yield* history.read();
      },
    ),

    // Internal one-way status path used by the active loop. Ignore late events
    // from a Turn that the Agent has already retired.
    reportProgress: schemas(
      {input: ProgressReportSchema, output: z.void()},
      function* (report: ProgressReport): Operation<void> {
        const current = yield* activeTurn.current();
        if (current?.id === report.turnId) {
          yield* progressLog.append(report);
        }
      },
    ),

    // Incremental progress feed for UIs. Progress is deliberately separate
    // from durable conversation history and retains only a bounded tail.
    progress: schemas(
      {input: ProgressQuerySchema, output: z.array(ProgressEventSchema)},
      function* ({afterSequence}): Operation<ProgressEvent[]> {
        return yield* progressLog.read(afterSequence);
      },
    ),

    // Internal registration path used by the humanApproval tool. The request
    // is accepted only while its originating Turn is still active.
    requestApproval: schemas(
      {input: ApprovalRequestSchema, output: z.boolean()},
      function* (request: ApprovalRequest): Operation<boolean> {
        const current = yield* activeTurn.current();
        if (current?.id !== request.turnId || current.interrupting) {
          return false;
        }
        return yield* approvals.register(request);
      },
    ),

    // Internal, idempotent cleanup when interruption or turn failure abandons
    // a tool that was waiting for approval.
    cancelApproval: schemas(
      {input: ApprovalCancellationSchema, output: z.void()},
      function* (request): Operation<void> {
        yield* approvals.cancel(request);
      },
    ),

    // Read-only pending approvals for a UI or human operator.
    approvals: schemas(
      {input: z.void(), output: z.array(ApprovalRequestSchema)},
      function* (): Operation<ApprovalRequest[]> {
        return yield* approvals.list();
      },
    ),

    // Resolve one pending request and deliver the decision to the waiting tool
    // as a signal on its Turn invocation.
    resolveApproval: schemas(
      {input: ApprovalResolutionSchema, output: z.boolean()},
      function* (resolution): Operation<boolean> {
        const request = (yield* approvals.list()).find(
          (candidate) => candidate.approvalId === resolution.approvalId,
        );
        if (!request) {
          return false;
        }
        const current = yield* activeTurn.current();
        if (current?.id !== request.turnId || current.interrupting) {
          yield* approvals.cancel(request);
          return false;
        }
        return yield* approvals.resolve(resolution);
      },
    ),

    // The active Turn sends exactly one structured outcome here. Verify it
    // belongs to the active turn, append its user-facing result, retire the
    // turn, and dispatch anything still queued. An explicit interrupt event is
    // already in history; external cancellation gets one here. A graceful
    // interruption can additionally produce an assistant finalization.
    // This is intentionally high-level: detailed tool/model activity belongs
    // in Restate's invocation logs and observability, not conversation state.
    append: schemas(
      {input: TurnOutcomeSchema, output: z.void()},
      function* (outcome): Operation<void> {
        const finished = yield* activeTurn.finish(outcome);
        if (!finished) {
          return;
        }
        yield* approvals.clearTurn(outcome.turnId);

        yield* history.requeueLatestSteering(finished.missedSteeringMessages);
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
        yield* progressLog.append({
          turnId: outcome.turnId,
          phase: outcome.status,
          message:
            outcome.status === "completed"
              ? "Turn completed"
              : outcome.status === "interrupted"
                ? "Turn interrupted after graceful finalization"
                : `Turn failed: ${outcome.error}`,
        });
        const agentId = agentKey();
        const plan = yield* history.beginCompaction();
        if (plan) {
          yield* sendClient(Agent, agentId).compact(plan);
        }

        const queuedMessages =
          finished.missedSteeringMessages + finished.pendingMessages;
        if (queuedMessages > 0) {
          yield* startTurn(agentId, queuedMessages);
        }
      },
    ),

    // Read and summarize one reserved history prefix without blocking the
    // Agent's exclusive conversation handlers, then self-send the result to
    // the exclusive checkpoint application path.
    compact: function* (plan: ConversationCompactionPlan): Operation<void> {
      const input = yield* history.readCompaction(plan);
      if (!input) {
        return;
      }
      const result = yield* compactConversation(input);
      yield* sendClient(Agent, agentKey()).applyCompaction(result);
    },

    // The shared compaction handler returns a derived checkpoint here. History
    // validates the reserved prefix before replacing the previous summary.
    applyCompaction: function* (
      result: ConversationCompactionResult,
    ): Operation<void> {
      yield* history.finishCompaction(result);
    },
  },
  options: {
    enableLazyState: true,
    handlers: {
      append: {
        ingressPrivate: true,
        idempotencyRetention: 0,
        journalRetention: 0,
      },
      requestApproval: {ingressPrivate: true},
      cancelApproval: {ingressPrivate: true},
      reportProgress: {ingressPrivate: true},
      approvals: {shared: true, idempotencyRetention: 0, journalRetention: 0},
      progress: {shared: true, idempotencyRetention: 0, journalRetention: 0},
      history: {shared: true, idempotencyRetention: 0, journalRetention: 0},
      compact: {
        shared: true,
        ingressPrivate: true,
        idempotencyRetention: 0,
        journalRetention: 0,
      },
      applyCompaction: {
        ingressPrivate: true,
        idempotencyRetention: 0,
        journalRetention: 0,
      },
    },
  },
});

// Cross-component coordination belongs here: mark queued messages as active,
// prepare the complete transcript, then let activeTurn own the invocation.
function* startTurn(agentId: string, queuedMessages = 0): Operation<string> {
  if (queuedMessages > 0) {
    yield* history.append({
      role: "event",
      type: "dispatch",
      queuedMessages,
    });
  }
  const context = yield* history.context();
  return yield* activeTurn.start({
    agentId,
    summary: context.summary,
    history: context.entries,
  });
}
