// Turn is the turn policy: a stateless service that supervises one
// conversation turn. The thinking itself — the model -> tools -> model cycle —
// is the concrete agent loop (see ./agent-loop). This file decides everything
// around it: what starts a turn, what interrupts or redirects it, and how its
// ending is reported.
//
// It owns no state at all. The Agent owns the durable conversation transcript
// and active turn id. This service sends exactly one structured outcome back
// to `Agent.append`; model and tool details remain in Restate's invocation
// observability instead of becoming user-facing conversation state.
//
// The turn's identity is its own invocation id: minted by the send that starts
// the turn (so the Agent knows it without a handshake) and used as the target
// for the control signals:
//   - INTERRUPT ends the turn
//   - STEERING  aborts the current run and reruns it on a new instruction
// `startTurn`/`interruptTurn`/`steerTurn` are the lifecycle API the Agent uses.

import {CancelledError} from "@restatedev/restate-sdk";
import {
  handlerRequest,
  InterruptedError,
  invocation,
  type Operation,
  schemas,
  select,
  sendClient,
  service,
  signal,
  spawn,
  type Task,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {Agent} from "./agent";
import {agentLoop, type ModelMessage} from "./agent-loop";
import {
  type ConversationEntry,
  type TurnOutcome,
  type TurnRequest,
  TurnRequestSchema,
} from "./types";

// Signal names used to control a running turn.
const INTERRUPT = "interrupt";
const STEERING = "steering";

// The Agent keeps the complete durable transcript; the model receives only a
// bounded recent window. Failed and interrupted summaries are operational
// outcomes, not assistant answers, so they must not be presented as if the
// model said them.
export const MAX_CONTEXT_MESSAGES = 40;

export function buildModelContext(
  history: ConversationEntry[],
): ModelMessage[] {
  return history
    .flatMap((entry): ModelMessage[] => {
      if (entry.role === "user") {
        return [{role: "user", content: entry.text}];
      }
      return entry.status === "completed"
        ? [{role: "assistant", content: entry.text}]
        : [];
    })
    .slice(-MAX_CONTEXT_MESSAGES);
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
    // Drive one turn: run the agent loop against the interrupt/steering signals,
    // then report a single summary. The input is validated against
    // TurnRequestSchema.
    //   - loop completes -> status "completed", text = the answer
    //   - loop fails     -> status "failed", text = the reported error
    //   - interrupt      -> status "interrupted", text = the reason
    //   - steer          -> interrupt the loop, rerun it on the steering message
    //   - loop throws    -> status "failed", text = the unexpected error
    // Only one TurnOutcome (turnId + status + text) reaches the transcript, so
    // the turn cannot finish silently and leave the Agent marked busy.
    run: schemas(
      {input: TurnRequestSchema, output: z.void()},
      function* (req: TurnRequest): Operation<void> {
        // This turn's own invocation id is its identity; the Agent stored it
        // when it started us.
        const turnId = handlerRequest().id;

        const interrupt = signal<string>(INTERRUPT);
        let steering = signal<string>(STEERING);

        // The model context ends with the message that triggered this turn.
        // Steering messages are added as newer instructions when they arrive.
        let context = buildModelContext(req.history);
        let activeTask: Task<unknown> | undefined;

        try {
          let outcome: TurnOutcome | undefined;

          // Labelled so a case can break the loop; a bare `break` only leaves the switch.
          turn: while (true) {
            const task = spawn(agentLoop(context));
            activeTask = task;
            const selected = yield* select({answer: task, interrupt, steering});

            switch (selected.tag) {
              case "answer": {
                const result = yield* selected.future;
                activeTask = undefined;
                outcome = {
                  turnId,
                  status: result.status,
                  text:
                    result.status === "completed" ? result.text : result.error,
                };
                break turn;
              }
              case "interrupt": {
                const reason = yield* selected.future;
                yield* stopAgentLoop(task);
                activeTask = undefined;
                outcome = {turnId, status: "interrupted", text: reason};
                break turn;
              }
              case "steering": {
                const steer = yield* selected.future;
                yield* stopAgentLoop(task);
                activeTask = undefined;
                steering = signal<string>(STEERING); // re-arm for the next steer
                // Add the steer to the current model context. The Agent already
                // recorded it in the durable conversation history.
                context = [
                  ...context,
                  {role: "user" as const, content: steer},
                ].slice(-MAX_CONTEXT_MESSAGES);
                break;
              }
            }
          }

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
            });
            throw error;
          }

          // Unexpected model/tool failures become one explicit turn outcome;
          // the controller is never left permanently busy.
          yield* sendClient(Agent, req.agentId).append({
            turnId,
            status: "failed",
            text: errorMessage(error),
          });
        }
      },
    ),
  },
});

// The turn lifecycle API the Agent uses to start and control a turn. Keeping
// all three here means the Agent never has to know about the Turn service or
// the signal protocol directly.

// Start a fresh turn; returns its invocation id — the Agent remembers it and
// interrupt/steer use it as their signal target.
export function* startTurn(req: TurnRequest): Operation<string> {
  const started = yield* sendClient(Turn).run(req);
  return started.id;
}

// Resolve a control signal on a running turn's invocation.
export function interruptTurn(turnId: string, reason: string): void {
  invocation(turnId).signal<string>(INTERRUPT).resolve(reason);
}
export function steerTurn(turnId: string, message: string): void {
  invocation(turnId).signal<string>(STEERING).resolve(message);
}
