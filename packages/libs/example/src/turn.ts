// TurnService owns the turn loop. It is stateless: everything durable lives in
// the Agent (see ./agent), and the turn talks to it only through one-way sends.
//
// A running turn is controlled through two signals raised on its own
// invocation:
//   - INTERRUPT ends the turn
//   - STEERING  aborts the current step and re-runs a fresh one on a new message
// `interruptTurn`/`steerTurn` are the API the Agent uses to raise them.

import {setTimeout} from "node:timers/promises";
import {durableSource, llmFetch} from "@restate-agents/core";
import {
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
import {type TurnRequest, TurnRequestSchema} from "./types";

// Signal names used to control a running turn.
const INTERRUPT = "interrupt";
const STEERING = "steering";

// A (mock) weather tool. It takes the run's AbortSignal, so interrupting the
// turn cancels the in-flight call instead of waiting for it.
async function getWeather(city: string, signal: AbortSignal) {
  await setTimeout(200, undefined, {signal}); // stand-in for a network call
  return {city, temp: 22, condition: "sunny"};
}

// One step of a turn: stream a completion and accumulate what happened into a
// single reply, which the turn uses as its summary. For now we just keep the
// message in a variable; the detailed per-turn conversation (each chunk, each
// tool call/result kept separately from the general conversation) is deferred.
function* step(message: string): Operation<string> {
  const stream = yield* durableSource(() => llmFetch(message));

  let reply = "";
  while (true) {
    const res = yield* stream.next();
    if (res.type !== "next") {
      break; // "done" (stream ended) or "aborted" (replayed past the stream)
    }
    const chunk = res.value;

    if (chunk.type === "tool_call") {
      // Durable + abortable: the run's signal fires if the step is interrupted.
      // `run` names the journal entry after the action's `Function.name`; this
      // arrow is anonymous, so pass an explicit (deterministic) name instead.
      const weather = yield* run(
        (opts) => getWeather(chunk.args.city, opts.signal),
        {name: "getWeather"},
      );
      reply += `[${chunk.name}: ${weather.temp}°C, ${weather.condition} in ${weather.city}] `;
    } else {
      reply += chunk.content;
    }
  }

  return reply;
}

// TurnService owns the turn loop. The Agent starts this and never awaits it.
export const TurnService = service({
  name: "TurnService",
  handlers: {
    // Drive one turn: run the step against the interrupt/steering signals, then
    // report the outcome. The input is validated against TurnRequestSchema.
    //   - step completes    -> the turn is done; its reply is the summary
    //   - interrupt         -> interrupt the step, end it ("interrupted: ...")
    //   - steer             -> interrupt the step, then run a fresh one on the
    //                          steering message
    //   - step throws       -> record the failure         ("failed: ...")
    // In every case a final entry is reported, so the conversation always ends
    // with a summary and the Agent clears the active turn. Without this, a
    // terminal failure in the step would skip the report, leaving the turn dead
    // but `turnId` set forever — the failure would vanish from the conversation.
    doTurn: schemas(
      {input: TurnRequestSchema, output: z.void()},
      function* (req: TurnRequest): Operation<void> {
        const interrupt = signal<string>(INTERRUPT);
        let steering = signal<string>(STEERING);

        // The message the current step runs on; a steer replaces it for the next.
        let message = req.message;
        let outcome = "completed";

        try {
          // Labelled so a case can break the loop; a bare `break` only leaves the switch.
          turn: while (true) {
            const task = spawn(step(message));
            const selected = yield* select({step: task, interrupt, steering});

            switch (selected.tag) {
              case "step": {
                // The step finished; its accumulated reply is the turn summary.
                outcome = (yield* selected.future) || "completed";
                break turn;
              }
              case "interrupt": {
                const reason = yield* selected.future;
                task.interrupt();
                try {
                  yield* task; // join so the step's finally/catch runs
                } catch {
                  // Swallow the interrupt.
                }
                outcome = `interrupted: ${reason}`;
                break turn;
              }
              case "steering": {
                message = yield* selected.future; // redirect the fresh step
                task.interrupt();
                try {
                  yield* task;
                } catch {
                  // Swallow the interrupt.
                }
                steering = signal<string>(STEERING); // re-arm for the next steer
                break;
              }
            }
          }
        } catch (err) {
          // The step failed terminally (LLM/tool error, invalid input, ...).
          // Record it as the outcome instead of letting the turn die silently.
          outcome = `failed: ${err instanceof Error ? err.message : String(err)}`;
        }

        // Always report a final entry — completed, interrupted, or failed — so
        // the conversation ends with a summary and the Agent clears the turn.
        yield* sendClient(Agent, req.conversationId).append({
          text: outcome,
          final: true,
        });
      },
    ),
  },
});

// The turn lifecycle API the Agent uses to start and control a turn. Keeping
// all three here means the Agent never has to know about TurnService or the
// signal protocol directly.

// Start a fresh turn for a conversation; returns its invocation id so the Agent
// can remember it and later interrupt/steer that exact turn.
export function* startTurn(req: TurnRequest): Operation<string> {
  const started = yield* sendClient(TurnService).doTurn(req);
  return started.id;
}

// Resolve a control signal on a running turn's invocation.
export function interruptTurn(turnId: string, reason: string): void {
  invocation(turnId).signal<string>(INTERRUPT).resolve(reason);
}
export function steerTurn(turnId: string, message: string): void {
  invocation(turnId).signal<string>(STEERING).resolve(message);
}
