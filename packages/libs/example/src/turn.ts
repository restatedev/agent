// TurnService owns the turn loop. It is stateless: durable conversation state
// lives in the Agent (general conversation) and in Turn (per-turn detail); the
// turn talks to both only through one-way sends.
//
// A running turn is controlled through two signals raised on its own invocation:
//   - INTERRUPT ends the turn
//   - STEERING  aborts the current run and reruns it on a new instruction
// `startTurn`/`interruptTurn`/`steerTurn` are the lifecycle API the Agent uses.

import {setTimeout} from "node:timers/promises";
import {durableSource} from "@restate-agents/core";
import {TerminalError} from "@restatedev/restate-sdk";
import {
  handlerRequest,
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
import {llmFetch, type ModelMessage} from "./model";
import {Turn} from "./turn-conversation";
import {type Message, type TurnRequest, TurnRequestSchema} from "./types";

// Signal names used to control a running turn.
const INTERRUPT = "interrupt";
const STEERING = "steering";

// Bound on the model->tool->model loop, so a model that keeps calling tools
// can't spin forever.
const MAX_STEPS = 8;

const toModelMessage = (m: Message): ModelMessage => ({
  role: m.role,
  content: m.text,
});

// A (mock) weather tool. It takes the run's AbortSignal, so interrupting the
// turn cancels the in-flight call instead of waiting for it.
async function getWeather(city: string, signal: AbortSignal) {
  await setTimeout(200, undefined, {signal}); // stand-in for a network call
  return {city, temp: 22, condition: "sunny"};
}

// Validate and run a tool call. An unknown tool or a missing arg returns an
// error string that is fed back to the model, so a bad call is recoverable
// rather than fatal.
function* runTool(call: {
  name: string;
  args: Record<string, string>;
}): Operation<string> {
  if (call.name !== "getWeather") {
    return `error: unknown tool "${call.name}"`;
  }
  const city = call.args.city;
  if (!city) {
    return 'error: getWeather requires a string "city" arg';
  }
  // Durable + abortable: the run's signal fires if the step is interrupted.
  // `run` names the journal entry after the action's `Function.name`; this arrow
  // is anonymous, so pass an explicit (deterministic) name instead.
  const weather = yield* run((opts) => getWeather(city, opts.signal), {
    name: "getWeather",
  });
  return `${weather.temp}°C, ${weather.condition} in ${weather.city}`;
}

// One model step: stream a completion, record each chunk to the per-turn
// conversation, and run any tool calls. Returns the assistant text plus the
// tool results (empty when the model produced a final answer).
function* modelStep(
  turnId: string,
  messages: ModelMessage[],
): Operation<{text: string; tools: {name: string; result: string}[]}> {
  // Own the abort so an interrupt tears down the in-flight HTTP stream, not just
  // the Restate task. The finally fires on normal completion and on the throw
  // that task.interrupt() injects mid-stream.
  const controller = new AbortController();
  try {
    const stream = yield* durableSource(() =>
      llmFetch(messages, controller.signal),
    );

    let text = "";
    const tools: {name: string; result: string}[] = [];
    while (true) {
      const res = yield* stream.next();
      if (res.type === "done") {
        break;
      }
      if (res.type === "aborted") {
        // Replay ran past a stream that no longer exists (a crash mid-response).
        // A model stream is not replayable, so fail explicitly rather than pass
        // a truncated answer off as complete.
        throw new TerminalError("model response was truncated on recovery");
      }
      const chunk = res.value;

      if (chunk.type === "tool_call") {
        const result = yield* runTool(chunk);
        yield* sendClient(Turn, turnId).append({
          role: "tool",
          text: `${chunk.name}(${JSON.stringify(chunk.args)}) → ${result}`,
        });
        tools.push({name: chunk.name, result});
      } else if (chunk.content) {
        text += chunk.content;
        yield* sendClient(Turn, turnId).append({
          role: "assistant",
          text: chunk.content,
        });
      }
    }

    return {text, tools};
  } finally {
    controller.abort();
  }
}

// Run the agent loop for one instruction: model -> tools -> model until the
// model answers with no tool call (bounded by MAX_STEPS). Returns the final
// answer text.
function* agentRun(turnId: string, context: ModelMessage[]): Operation<string> {
  const messages = [...context];
  for (let stepNo = 0; stepNo < MAX_STEPS; stepNo++) {
    const {text, tools} = yield* modelStep(turnId, messages);
    if (text) {
      messages.push({role: "assistant", content: text});
    }
    if (tools.length === 0) {
      return text; // final answer — the model asked for no more tools
    }
    for (const t of tools) {
      messages.push({role: "tool", content: `${t.name}: ${t.result}`});
    }
  }
  throw new TerminalError(
    `agent exceeded ${MAX_STEPS} steps without a final answer`,
  );
}

// TurnService owns the turn loop. The Agent starts this and never awaits it.
export const TurnService = service({
  name: "TurnService",
  handlers: {
    // Drive one turn: run the agent loop against the interrupt/steering signals,
    // then report a single summary. The input is validated against
    // TurnRequestSchema.
    //   - run completes -> the turn is done; its answer is the summary
    //   - interrupt     -> interrupt the run, end it ("interrupted: ...")
    //   - steer         -> interrupt the run, rerun on the steering message
    //   - run throws     -> record the failure ("failed: ...")
    // Detailed step output goes to the per-turn conversation (Turn); only this
    // one summary reaches the general conversation (Agent), and it always does,
    // so the turn can never die silently and leave `turnId` set forever.
    doTurn: schemas(
      {input: TurnRequestSchema, output: z.void()},
      function* (req: TurnRequest): Operation<void> {
        // This turn's own invocation id is the key of its per-turn conversation.
        const turnId = handlerRequest().id;
        const interrupt = signal<string>(INTERRUPT);
        let steering = signal<string>(STEERING);

        // The model context: the conversation so far (ending with the triggering
        // message). A steer replaces the trailing instruction for the rerun.
        const base = req.history.map(toModelMessage);
        let context = base;
        let outcome = "";

        try {
          // Labelled so a case can break the loop; a bare `break` only leaves the switch.
          turn: while (true) {
            const task = spawn(agentRun(turnId, context));
            const selected = yield* select({answer: task, interrupt, steering});

            switch (selected.tag) {
              case "answer": {
                outcome = (yield* selected.future) || "(no answer)";
                break turn;
              }
              case "interrupt": {
                const reason = yield* selected.future;
                task.interrupt();
                try {
                  yield* task; // join so the run's finally (HTTP abort) runs
                } catch {
                  // Swallow the interrupt.
                }
                outcome = `interrupted: ${reason}`;
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
                context = [...base, {role: "user", content: steer}];
                break;
              }
            }
          }
        } catch (err) {
          // The run failed terminally (model/tool error, truncated recovery,
          // step budget). Record it instead of letting the turn die silently.
          outcome = `failed: ${err instanceof Error ? err.message : String(err)}`;
        }

        // Always report exactly one summary to the general conversation.
        yield* sendClient(Agent, req.conversationId).recordSummary({
          text: outcome,
        });
      },
    ),
  },
});

// The turn lifecycle API the Agent uses to start and control a turn. Keeping
// all three here means the Agent never has to know about TurnService or the
// signal protocol directly.

// Start a fresh turn; returns its invocation id so the Agent can remember it and
// later interrupt/steer that exact turn.
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
