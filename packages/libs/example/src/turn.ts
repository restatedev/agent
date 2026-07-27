// Turn is the turn policy: a stateless service that supervises one
// conversation turn. The thinking itself — the model -> tools -> model cycle —
// is the concrete agent loop (see ./agent-loop). This file owns hard
// interruption and reports how the turn ended; the loop handles steering at
// safe model/tool boundaries without discarding its working context.
//
// It owns no state at all. The Agent owns the durable conversation transcript
// and active turn id. This service sends exactly one structured outcome back
// to `Agent.append`; model and tool details remain in Restate's invocation
// observability instead of becoming user-facing conversation state.
//
// The turn's identity is its own invocation id: minted by the send that starts
// the turn (so the Agent knows it without a handshake) and used as the target
// for the control signals:
//   - interrupt is consumed here and ends the turn
//   - steering is consumed cooperatively inside agentLoop
// The Agent-side lifecycle and signal senders live in agent-turn.ts.

import {CancelledError} from "@restatedev/restate-sdk";
import {
  handlerRequest,
  InterruptedError,
  type Operation,
  schemas,
  select,
  sendClient,
  service,
  signal,
  spawn,
  type Task,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";
import {z} from "zod";
import {Agent} from "./agent.js";
import {agentLoop} from "./agent-loop.js";
import {
  type ConversationEntry,
  type TurnOutcome,
  type TurnRequest,
  TurnRequestSchema,
} from "./types.js";

// Signal used to stop a running turn immediately.
const INTERRUPT = "interrupt";

// Build summary + uncompacted model-visible history. Failed and interrupted
// outcomes are operational events, not assistant answers.
function buildModelContext(
  history: ConversationEntry[],
  summary?: string,
): ModelMessage[] {
  const uncompacted = history.flatMap((entry): ModelMessage[] => {
    if (entry.role === "user") {
      return [{role: "user", content: entry.text}];
    }
    return entry.role === "assistant" && entry.status === "completed"
      ? [{role: "assistant", content: entry.text}]
      : [];
  });
  return summary
    ? [
        {
          role: "user",
          content: [
            "[Earlier conversation summary]",
            "This is context derived from older turns. Newer messages take precedence.",
            summary,
          ].join("\n"),
        },
        ...uncompacted,
      ]
    : uncompacted;
}

function* stopAgentLoop(task: Task<unknown>): Operation<void> {
  task.interrupt();
  try {
    yield* task; // join so abort and finally blocks run before we continue
  } catch (error) {
    if (!(error instanceof InterruptedError)) {
      throw error;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const Turn = service({
  name: "Turn",
  handlers: {
    // Drive one turn: race the agent loop against hard interruption, then
    // report a single summary. Steering is handled cooperatively by the loop.
    // The input is validated against TurnRequestSchema.
    //   - loop completes -> status "completed", text = the answer
    //   - loop fails     -> status "failed", text = the reported error
    //   - interrupt      -> status "interrupted", text = the reason
    //   - loop throws    -> status "failed", text = the unexpected error
    // Only one TurnOutcome reaches the transcript. It includes the number of
    // steering signals consumed so the Agent can recover a completion race.
    run: schemas(
      {input: TurnRequestSchema, output: z.void()},
      function* (req: TurnRequest): Operation<void> {
        // This turn's own invocation id is its identity; the Agent stored it
        // when it started us.
        const turnId = handlerRequest().id;

        const interrupt = signal<string>(INTERRUPT);
        let activeTask: Task<unknown> | undefined;

        try {
          const task = spawn(
            agentLoop({
              agentId: req.agentId,
              turnId,
              messages: buildModelContext(req.history, req.summary),
            }),
          );
          activeTask = task;
          // Prefer a hard interrupt if it races with normal completion.
          const selected = yield* select({interrupt, answer: task});
          let outcome: TurnOutcome;
          if (selected.tag === "interrupt") {
            const reason = yield* selected.future;
            yield* stopAgentLoop(task);
            outcome = {
              turnId,
              status: "interrupted",
              text: reason,
              consumedSteering: 0,
            };
          } else {
            const result = yield* selected.future;
            outcome = {
              turnId,
              status: result.status,
              text: result.status === "completed" ? result.text : result.error,
              consumedSteering: result.consumedSteering,
            };
          }
          activeTask = undefined;

          yield* sendClient(Agent, req.agentId).append(outcome);
        } catch (error) {
          if (error instanceof CancelledError) {
            // Cancellation aborts in-flight run I/O first. Join the spawned loop
            // for cleanup, retire the controller's active turn, then rethrow so
            // Restate still records this invocation as cancelled.
            if (activeTask) {
              activeTask.interrupt(error);
              try {
                yield* activeTask;
              } catch {
                // Preserve the invocation's original cancellation.
              }
            }
            yield* sendClient(Agent, req.agentId).append({
              turnId,
              status: "interrupted",
              text: "Turn cancelled",
              consumedSteering: 0,
            });
            throw error;
          }

          // Unexpected model/tool failures become one explicit turn outcome;
          // the controller is never left permanently busy.
          yield* sendClient(Agent, req.agentId).append({
            turnId,
            status: "failed",
            text: errorMessage(error),
            consumedSteering: 0,
          });
        }
      },
    ),
  },
  options: {
    handlers: {
      run: {
        ingressPrivate: true,
        inactivityTimeout: {hours: 1},
        abortTimeout: {minutes: 15},
      },
    },
  },
});
