// Turn is the turn policy: a stateless service that supervises one
// conversation turn. The thinking itself — the model -> tools -> model cycle —
// is the concrete agent loop (see ./agent-loop). This file owns the durable
// interrupt signal and reports how the turn ended; the loop handles steering
// and graceful interruption without discarding its working context.
//
// It owns no state at all. The Agent owns the durable conversation transcript
// and active turn id. This service sends exactly one structured outcome back
// to `Agent.append`; model and tool details remain in Restate's invocation
// observability instead of becoming user-facing conversation state.
//
// The turn's identity is its own invocation id: minted by the send that starts
// the turn (so the Agent knows it without a handshake) and used as the target
// for the control signals:
//   - interrupt is passed into agentLoop for graceful finalization
//   - steering is consumed cooperatively inside agentLoop
// The Agent-side lifecycle and signal senders live in agent-turn.ts.

import {CancelledError} from "@restatedev/restate-sdk";
import {
  handlerRequest,
  type Operation,
  schemas,
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
  TURN_SIGNALS,
  type TurnOutcome,
  type TurnRequest,
  TurnRequestSchema,
} from "./types.js";

function interruptionBoundary(
  entry: Extract<ConversationEntry, {role: "event"; type: "interrupt"}>,
): ModelMessage {
  return {
    role: "user",
    content: [
      "[Turn interruption boundary]",
      `Turn: ${entry.turnId}`,
      `Reason: ${JSON.stringify(entry.reason)}`,
      "The prior turn was asked to stop or was externally cancelled.",
      "Treat requests before this boundary as conversation context, not unfinished work to resume automatically.",
      "Do not assume tools from that turn completed. Act on earlier requests only when the new turn messages explicitly refer to them.",
    ].join("\n"),
  };
}

function failureBoundary(
  entry: Extract<ConversationEntry, {role: "assistant"}>,
): ModelMessage {
  return {
    role: "user",
    content: [
      "[Previous turn failed]",
      `Turn: ${entry.turnId}`,
      `Failure: ${JSON.stringify(entry.text)}`,
      "Treat requests before this boundary as conversation context, not unfinished work to resume automatically.",
    ].join("\n"),
  };
}

function dispatchBoundary(
  entry: Extract<ConversationEntry, {role: "event"; type: "dispatch"}>,
): ModelMessage {
  return {
    role: "user",
    content: [
      "[Queued messages activated]",
      `The ${entry.queuedMessages} most recent user message(s) marked as queued are the input for this turn.`,
      "Process them now. Assistant messages or lifecycle events appearing after their original transcript positions did not answer them.",
    ].join("\n"),
  };
}

function userMessage(
  entry: Extract<ConversationEntry, {role: "user"}>,
): string {
  if (entry.delivery === "queued") {
    return [
      "[Queued user message]",
      "This arrived while another turn was active and was not part of that turn's input.",
      entry.text,
    ].join("\n");
  }
  if (entry.delivery !== "steer") {
    return entry.text;
  }
  // A later Turn should retain the fact that this instruction redirected an
  // earlier active Turn, just as that Turn saw it through its steering signal.
  return [
    "[Steering message delivered during the previous turn]",
    entry.text,
  ].join("\n");
}

// Project one canonical transcript into model messages. Delivery metadata and
// lifecycle events remain visible without inventing a second message stream.
function buildModelContext(
  history: ConversationEntry[],
  summary?: string,
): ModelMessage[] {
  const uncompacted = history.flatMap((entry): ModelMessage[] => {
    if (entry.role === "user") {
      return [{role: "user", content: userMessage(entry)}];
    }
    if (entry.role === "event") {
      // Progress is part of the canonical transcript for consumers, but it is
      // derived execution status rather than conversation input.
      if (entry.type === "progress") {
        return [];
      }
      return [
        entry.type === "interrupt"
          ? interruptionBoundary(entry)
          : dispatchBoundary(entry),
      ];
    }
    return entry.status === "failed"
      ? [failureBoundary(entry)]
      : [{role: "assistant", content: entry.text}];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const Turn = service({
  name: "Turn",
  handlers: {
    // Drive one turn and report one structured outcome. Steering and graceful
    // interruption are handled cooperatively by the loop.
    // The input is validated against TurnRequestSchema.
    //   - loop completes -> status "completed", response = the answer
    //   - loop fails     -> status "failed", error = the reported error
    //   - interrupt      -> status "interrupted", response = final answer
    //   - loop throws    -> status "failed", error = the unexpected error
    // Only one TurnOutcome reaches the transcript. It includes the number of
    // steering signals consumed so the Agent can recover a completion race.
    run: schemas(
      {input: TurnRequestSchema, output: z.void()},
      function* (req: TurnRequest): Operation<void> {
        // This turn's own invocation id is its identity; the Agent stored it
        // when it started us.
        const turnId = handlerRequest().id;

        const interrupt = signal<string>(TURN_SIGNALS.interrupt);
        let activeTask: Task<unknown> | undefined;

        try {
          const task = spawn(
            agentLoop({
              agentId: req.agentId,
              turnId,
              messages: buildModelContext(req.history, req.summary),
              interrupt,
            }),
          );
          activeTask = task;
          const result = yield* task;
          let outcome: TurnOutcome;
          if (result.status === "completed") {
            outcome = {
              turnId,
              status: result.status,
              response: result.text,
              consumedSteering: result.consumedSteering,
            };
          } else if (result.status === "interrupted") {
            outcome = {
              turnId,
              status: result.status,
              reason: result.reason,
              response: result.text,
              consumedSteering: result.consumedSteering,
            };
          } else {
            outcome = {
              turnId,
              status: result.status,
              error: result.error,
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
              reason: "Turn cancelled",
              consumedSteering: 0,
            });
            throw error;
          }

          // Unexpected model/tool failures become one explicit turn outcome;
          // the controller is never left permanently busy.
          yield* sendClient(Agent, req.agentId).append({
            turnId,
            status: "failed",
            error: errorMessage(error),
            consumedSteering: 0,
          });
        }
      },
    ),
  },
  options: {
    handlers: {
      run: {
        inactivityTimeout: {hours: 1},
        abortTimeout: {minutes: 15},
      },
    },
  },
});
