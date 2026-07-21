// Turn is the turn policy: a stateless service that supervises one
// conversation turn. The thinking itself — the model -> tools -> model cycle —
// is the concrete agent loop (see ./agent-loop). This file decides everything
// around it: what starts a turn, what interrupts or redirects it, and how its
// ending is reported.
//
// It owns no state at all. Everything durable about a turn lives in the Agent
// — the conversation object — because it is conversation data: the transcript,
// the active turn id, and the per-turn detailed trace. The turn reports into
// the Agent with one-way sends: `appendTrace` per detailed step, then exactly
// one `recordSummary`. Restate delivers sends from one invocation to one
// object key in submission order, so every trace entry lands while this turn
// is still the active one — the summary (sent last) is what retires it. That
// ordering is why appendTrace carries no turn id: the Agent files each entry
// under its own notion of the active turn, which is exactly this turn.
//
// The turn's identity is its own invocation id: minted by the send that starts
// the turn (so the Agent knows it without a handshake), it keys the trace
// inside the Agent and is the target for the control signals:
//   - INTERRUPT ends the turn
//   - STEERING  aborts the current run and reruns it on a new instruction
// `startTurn`/`interruptTurn`/`steerTurn` are the lifecycle API the Agent uses.

import {
  handlerRequest,
  invocation,
  type Operation,
  schemas,
  select,
  sendClient,
  service,
  signal,
  spawn,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {Agent} from "./agent";
import {agentLoop, type ModelMessage, type Reporter} from "./agent-loop";
import {
  type ConversationEntry,
  type TurnRequest,
  TurnRequestSchema,
  type TurnStatus,
} from "./types";

// Signal names used to control a running turn.
const INTERRUPT = "interrupt";
const STEERING = "steering";

const toModelMessage = (e: ConversationEntry): ModelMessage => ({
  role: e.role,
  content: e.text,
});

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
    // Detailed step output goes to the Agent's per-turn trace (via appendTrace
    // sends); only one TurnOutcome (turnId + status + text) reaches the
    // transcript, and it always does, so the turn can't die silently and leave
    // the Agent's active turn set forever.
    run: schemas(
      {input: TurnRequestSchema, output: z.void()},
      function* (req: TurnRequest): Operation<void> {
        // This turn's own invocation id is its identity: the Agent stored it
        // when it started us, and it keys this turn's trace over there.
        const turnId = handlerRequest().id;

        // Bind the turn-scoped trace destination. The entry carries no turn id
        // — the Agent attributes it to its active turn, which (by send ordering)
        // is exactly this one.
        const report: Reporter = (entry) =>
          sendClient(Agent, req.agentId).appendTrace(entry);

        const interrupt = signal<string>(INTERRUPT);
        let steering = signal<string>(STEERING);

        // The model context: the conversation so far (ending with the triggering
        // message). A steer replaces the trailing instruction for the rerun.
        let context = req.history.map(toModelMessage);
        let status: TurnStatus = "completed";
        let text = "";

        try {
          // Labelled so a case can break the loop; a bare `break` only leaves the switch.
          turn: while (true) {
            const task = spawn(agentLoop(context, report));
            const selected = yield* select({answer: task, interrupt, steering});

            switch (selected.tag) {
              case "answer": {
                const result = yield* selected.future;
                status = result.status;
                text =
                  result.status === "completed" ? result.text : result.error;
                break turn;
              }
              case "interrupt": {
                text = yield* selected.future;
                status = "interrupted";
                task.interrupt();
                try {
                  yield* task; // join so the loop's teardown (HTTP abort) runs
                } catch {
                  // Swallow the interrupt.
                }
                break turn;
              }
              case "steering": {
                const steer = yield* selected.future;
                task.interrupt();
                try {
                  yield* task;
                } catch {
                  // Swallow the interrupt.
                }
                steering = signal<string>(STEERING); // re-arm for the next steer
                // Record the steer in this turn's trace and add it to the
                // context so the rerun (and the model) sees it. (The Agent also
                // records it in the general conversation.)
                yield* report({role: "user", text: steer});
                context = [...context, {role: "user", content: steer}];
                break;
              }
            }
          }
        } catch (err) {
          // An unexpected model/tool failure escaped the structured loop
          // result. Record it instead of letting the turn die silently.
          status = "failed";
          text = err instanceof Error ? err.message : String(err);
        }

        // Always report exactly one outcome to the general conversation.
        yield* sendClient(Agent, req.agentId).recordSummary({
          turnId,
          status,
          text,
        });
      },
    ),
  },
});

// The turn lifecycle API the Agent uses to start and control a turn. Keeping
// all three here means the Agent never has to know about the Turn service or
// the signal protocol directly.

// Start a fresh turn; returns its invocation id — the turn's whole identity:
// the Agent remembers it, the trace is keyed by it, interrupt/steer target it.
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
