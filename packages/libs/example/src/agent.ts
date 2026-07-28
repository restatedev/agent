// Agent is the durable conversation controller. It is a Virtual Object keyed
// by agent id, so its exclusive handlers serialize every decision about the
// active turn, queued messages, user-facing history, and summary checkpoints.
//
// It never runs turn execution itself. `ask` starts or queues work,
// `interrupt` and `steer` resolve signals on the active stateless Turn
// invocation, and `append` accepts that Turn's single high-level outcome.

import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {approvals} from "./agent-approval.js";
import {
  type ConversationCompactionPlan,
  type ConversationCompactionResult,
  history,
} from "./agent-history.js";
import {activeTurn} from "./agent-turn.js";
import {compactConversation} from "./conversation-compactor.js";
import {
  ApprovalCancellationSchema,
  type ApprovalRequest,
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  type HistoryPage,
  HistoryPageSchema,
  type ProgressReport,
  ProgressReportSchema,
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

const HistoryQuerySchema = z.object({
  fromSequence: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(50),
});

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

    // Explicitly stop the active turn; the input is the reason. No intent
    // guessing — this is the API a stop button calls. Returns whether the stop
    // was requested; false means there was nothing to stop (idle, or already
    // winding down from an earlier interrupt) and nothing happened.
    interrupt: restate.schemas(
      {input: z.string(), output: z.boolean()},
      function* (reason): restate.Operation<boolean> {
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
    // are sent first, followed by the new instruction. The transcript records
    // this as an append-only lifecycle event. Returns false when no turn is
    // listening, in which case the queue remains untouched.
    steer: restate.schemas(
      {input: z.string(), output: z.boolean()},
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

    // Internal registration path used by the humanApproval tool. The request
    // is accepted only while its originating Turn is still active.
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
    // a tool that was waiting for approval.
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
    // as a signal on its Turn invocation.
    resolveApproval: restate.schemas(
      {input: ApprovalResolutionSchema, output: z.boolean()},
      function* (resolution): restate.Operation<boolean> {
        const current = yield* activeTurn.current();
        return yield* approvals.resolve(
          resolution,
          current?.interrupting ? undefined : current?.id,
        );
      },
    ),

    // The active Turn sends exactly one structured outcome here. Verify it
    // belongs to the active turn, append its user-facing result, retire the
    // turn, and dispatch anything still queued. An explicit interrupt event is
    // already in history; external cancellation gets one here. A graceful
    // interruption can additionally produce an assistant finalization.
    // This is intentionally high-level: detailed tool/model activity belongs
    // in Restate's invocation logs and observability, not conversation state.
    append: restate.schemas(
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
        const plan = yield* history.beginCompaction();
        if (plan) {
          yield* restate.sendClient(Agent, agentId).compact(plan);
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
    compact: function* (
      plan: ConversationCompactionPlan,
    ): restate.Operation<void> {
      const input = yield* history.readCompaction(plan);
      if (!input) {
        return;
      }
      const result = yield* compactConversation(input);
      yield* restate.sendClient(Agent, agentKey()).applyCompaction(result);
    },

    // The shared compaction handler returns a derived checkpoint here. History
    // validates the reserved prefix before replacing the previous summary.
    applyCompaction: function* (
      result: ConversationCompactionResult,
    ): restate.Operation<void> {
      yield* history.finishCompaction(result);
    },
  },
  options: {
    enableLazyState: true,
    handlers: {
      append: {
        idempotencyRetention: 0,
        journalRetention: 0,
      },
      approvals: {shared: true, idempotencyRetention: 0, journalRetention: 0},
      history: {shared: true, idempotencyRetention: 0, journalRetention: 0},
      compact: {
        shared: true,
        idempotencyRetention: 0,
        journalRetention: 0,
      },
      applyCompaction: {
        idempotencyRetention: 0,
        journalRetention: 0,
      },
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
  return yield* activeTurn.start({
    agentId,
    summary: context.summary,
    history: context.entries,
  });
}
