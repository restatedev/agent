// Turn is the turn policy: a stateless service that supervises one
// conversation turn. The thinking itself — the model -> tools -> model cycle —
// is the agent loop (see ./loop); this file binds the loop's dependencies (the
// example's model, its tools, the trace reporter) and decides everything
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

import {setTimeout} from "node:timers/promises";
import {
  handlerRequest,
  InterruptedError,
  invocation,
  type Operation,
  run,
  schemas,
  select,
  sendClient,
  service,
  signal,
  spawn,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {Agent} from "./agent";
import {
  agentLoop,
  type LoopDeps,
  type ModelMessage,
  type Reporter,
  type ToolCall,
} from "./loop";
import {openAiModel} from "./model";
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

// A (mock) weather tool. It takes the run's AbortSignal, so interrupting the
// turn cancels the in-flight call instead of waiting for it.
async function getWeather(city: string, signal: AbortSignal) {
  await setTimeout(200, undefined, {signal}); // stand-in for a network call
  return {city, temp: 22, condition: "sunny"};
}

// Validate and run a tool call, returning a result string for the model. Every
// failure the model could act on is returned as an `error: ...` string rather
// than thrown, so the loop feeds it back and the model can adapt: an unknown
// tool, a missing arg, or the tool itself failing.
function* runTool(call: ToolCall): Operation<string> {
  if (call.name !== "getWeather") {
    return `error: unknown tool "${call.name}"`;
  }
  const city = call.args.city;
  if (!city) {
    return 'error: getWeather requires a string "city" arg';
  }
  try {
    // Durable + abortable: the run's signal fires if the step is interrupted.
    // `run` names the journal entry after the action's `Function.name`; this
    // arrow is anonymous, so pass an explicit (deterministic) name instead.
    const weather = yield* run((opts) => getWeather(city, opts.signal), {
      name: "getWeather",
    });
    return `${weather.temp}°C, ${weather.condition} in ${weather.city}`;
  } catch (err) {
    // An interrupt is delivered as an InterruptedError (task.interrupt injects
    // it) and MUST propagate, so the turn actually stops instead of feeding the
    // "failure" back and looping. Any other failure is the tool's own — return
    // it as an error result the model can react to (the mock never fails, but a
    // real tool would).
    if (err instanceof InterruptedError) {
      throw err;
    }
    return `error: getWeather failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const Turn = service({
  name: "Turn",
  handlers: {
    // Drive one turn: run the agent loop against the interrupt/steering signals,
    // then report a single summary. The input is validated against
    // TurnRequestSchema.
    //   - loop completes -> status "completed", text = the answer
    //   - interrupt      -> status "interrupted", text = the reason
    //   - steer          -> interrupt the loop, rerun it on the steering message
    //   - loop throws    -> status "failed", text = the error
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

        // Bind the loop's dependencies once for this turn: the example's model
        // and tools, and a reporter that files trace entries with the
        // conversation. The entry carries no turn id — the Agent attributes it
        // to its active turn, which (by send ordering) is exactly this one.
        const report: Reporter = (entry) =>
          sendClient(Agent, req.conversationId).appendTrace(entry);
        const deps: LoopDeps = {model: openAiModel, runTool, report};

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
            const task = spawn(agentLoop(deps, context));
            const selected = yield* select({answer: task, interrupt, steering});

            switch (selected.tag) {
              case "answer": {
                text = (yield* selected.future) || "(no answer)";
                status = "completed";
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
          // The loop failed terminally (model/tool error, truncated recovery,
          // round budget). Record it instead of letting the turn die silently.
          status = "failed";
          text = err instanceof Error ? err.message : String(err);
        }

        // Always report exactly one outcome to the general conversation.
        yield* sendClient(Agent, req.conversationId).recordSummary({
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
