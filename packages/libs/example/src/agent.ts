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
import {activeTurn} from "./agent-turn.js";
import {compactConversation} from "./conversation-compactor.js";
import {
  ApprovalCancellationSchema,
  type ApprovalRequest,
  ApprovalRequestSchema,
  ApprovalResolutionSchema,
  type ConversationEntry,
  ConversationEntrySchema,
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
          return {
            decision: "queue",
            turnId: current.id,
            stats: {pendingMessages},
          };
        }

        const turnId = yield* dispatchTurn(agentId, [message], "turn");
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

    // Explicitly redirect the active turn with a new instruction. Returns
    // whether a turn will act on it; false means no turn is listening (idle,
    // or winding down after an interrupt) and nothing was recorded — the
    // caller decides the fallback (typically sending the message via `ask`,
    // which queues it for the next turn).
    steer: schemas(
      {input: z.string(), output: z.boolean()},
      function* (message): Operation<boolean> {
        if (!(yield* activeTurn.steer(message))) {
          return false;
        }
        yield* history.append({role: "user", text: message, delivery: "steer"});
        return true;
      },
    ),

    // Read-only view of the general conversation. Includes queued-but-not-yet-
    // started messages (as user entries) so an accepted message is visible
    // immediately, even before its turn begins.
    history: schemas(
      {input: z.void(), output: z.array(ConversationEntrySchema)},
      function* (): Operation<ConversationEntry[]> {
        const entries = yield* history.read();
        const pending = yield* activeTurn.pending();
        return [
          ...entries,
          ...pending.map(
            (text): ConversationEntry => ({
              role: "user",
              text,
              delivery: "queued",
            }),
          ),
        ];
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
    // belongs to the active turn, append the user-facing assistant entry,
    // retire the turn, and start one batch turn for anything queued meanwhile.
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

        const unconsumedSteering = yield* history.takeLatestSteering(
          finished.missedSteering,
        );
        yield* history.append({
          role: "assistant",
          text: outcome.text,
          turnId: outcome.turnId,
          status: outcome.status,
        });
        const agentId = agentKey();
        const plan = yield* history.beginCompaction();
        if (plan) {
          yield* sendClient(Agent, agentId).compact(plan);
        }

        const pending = [...unconsumedSteering, ...finished.pending];
        if (pending.length > 0) {
          yield* dispatchTurn(agentId, pending, "queued");
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
      approvals: {shared: true, idempotencyRetention: 0, journalRetention: 0},
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

// Cross-component coordination belongs here: record the input, prepare the
// Turn request, then ask activeTurn to own its lifecycle.
function* dispatchTurn(
  agentId: string,
  messages: string[],
  delivery: "turn" | "queued",
): Operation<string> {
  yield* history.append(
    ...messages.map(
      (text): ConversationEntry => ({role: "user", text, delivery}),
    ),
  );
  const context = yield* history.context();
  return yield* activeTurn.start({
    agentId,
    summary: context.summary,
    history: context.entries,
  });
}
