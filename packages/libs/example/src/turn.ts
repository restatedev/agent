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
import {
  type LLMChunk,
  llmFetch,
  type ModelMessage,
  parseProgram,
} from "./model";
import {Turn} from "./turn-conversation";
import {
  type ConversationEntry,
  type TurnRequest,
  TurnRequestSchema,
  type TurnStatus,
} from "./types";

// Signal names used to control a running turn.
const INTERRUPT = "interrupt";
const STEERING = "steering";

// Bound on the agent loop (model rounds, including error-feedback retries), so a
// model that keeps calling tools — or keeps producing junk — can't spin forever.
const MAX_ROUNDS = 8;

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

// The outcome of one model round: either the model's text plus any tool results,
// or a recoverable error to feed back to the model so it can self-correct.
type StepOutcome =
  | {
      text: string;
      tools: {name: string; args: Record<string, string>; result: string}[];
    }
  | {error: string};

// One model round: durably pull the raw completion, then parse and run it.
// Parsing happens OUTSIDE the durable pull, so a malformed response is a
// recoverable `{error}` (fed back to the model) rather than a terminal failure.
// Interrupts and genuine stream failures surface from the pull and propagate.
function* modelStep(
  turnId: string,
  messages: ModelMessage[],
): Operation<StepOutcome> {
  // Own the abort so an interrupt tears down the in-flight HTTP stream, not just
  // the Restate task. The finally fires on normal completion and on the throw
  // that task.interrupt() injects mid-stream.
  const controller = new AbortController();
  let raw = "";
  try {
    const stream = yield* durableSource(() =>
      llmFetch(messages, controller.signal),
    );
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
      raw += res.value;
    }
  } finally {
    controller.abort();
  }

  // Parse outside the durable pull: a malformed response is the model's mistake,
  // recoverable by feeding it back — not a terminal stream error.
  let chunks: LLMChunk[];
  try {
    chunks = parseProgram(raw);
  } catch (err) {
    return {error: err instanceof Error ? err.message : String(err)};
  }

  let text = "";
  const tools: {name: string; args: Record<string, string>; result: string}[] =
    [];
  for (const chunk of chunks) {
    if (chunk.type === "tool_call") {
      const result = yield* runTool(chunk);
      yield* sendClient(Turn, turnId).append({
        role: "tool",
        text: `${chunk.name}(${JSON.stringify(chunk.args)}) → ${result}`,
      });
      tools.push({name: chunk.name, args: chunk.args, result});
    } else if (chunk.content) {
      text += chunk.content;
      yield* sendClient(Turn, turnId).append({
        role: "assistant",
        text: chunk.content,
      });
    }
  }
  return {text, tools};
}

// Feed a recoverable error/observation back to the model and record it in the
// per-turn trace, so the next round can self-correct.
function* observe(
  turnId: string,
  messages: ModelMessage[],
  note: string,
): Operation<void> {
  messages.push({role: "user", content: note});
  yield* sendClient(Turn, turnId).append({role: "tool", text: note});
}

// Run the agent loop for one instruction: model -> tools -> model until the model
// answers with no tool call. A recoverable model mistake — a malformed response
// or an empty one — is fed back as an observation so the model self-corrects next
// round rather than failing the turn. Bounded by MAX_ROUNDS.
function* agentRun(turnId: string, context: ModelMessage[]): Operation<string> {
  const messages = [...context];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const step = yield* modelStep(turnId, messages);

    if ("error" in step) {
      yield* observe(
        turnId,
        messages,
        `Your last response could not be used (${step.error}). Reply with valid protocol JSON.`,
      );
      continue;
    }

    const {text, tools} = step;
    if (text) {
      messages.push({role: "assistant", content: text});
    }
    if (tools.length === 0) {
      if (text) {
        return text; // final answer — the model asked for no more tools
      }
      yield* observe(
        turnId,
        messages,
        "Your last response was empty. Call a tool or give a final answer.",
      );
      continue;
    }
    for (const t of tools) {
      // Preserve the model's own tool request in context, then its result, so the
      // next inference sees the full request/response pair.
      messages.push({
        role: "assistant",
        content: JSON.stringify({
          type: "tool_call",
          name: t.name,
          args: t.args,
        }),
      });
      messages.push({role: "tool", content: `${t.name}: ${t.result}`});
    }
  }
  throw new TerminalError(`agent did not finish within ${MAX_ROUNDS} rounds`);
}

// TurnService owns the turn loop. The Agent starts this and never awaits it.
export const TurnService = service({
  name: "TurnService",
  handlers: {
    // Drive one turn: run the agent loop against the interrupt/steering signals,
    // then report a single summary. The input is validated against
    // TurnRequestSchema.
    //   - run completes -> status "completed", text = the answer
    //   - interrupt     -> status "interrupted", text = the reason
    //   - steer         -> interrupt the run, rerun on the steering message
    //   - run throws     -> status "failed", text = the error
    // Detailed step output goes to the per-turn conversation (Turn); only one
    // TurnOutcome (turnId + status + text) reaches the general conversation
    // (Agent), and it always does, so the turn can't die silently and leave
    // `turnId` set forever.
    doTurn: schemas(
      {input: TurnRequestSchema, output: z.void()},
      function* (req: TurnRequest): Operation<void> {
        // This turn's own invocation id is the key of its per-turn conversation.
        const turnId = handlerRequest().id;
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
            const task = spawn(agentRun(turnId, context));
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
                  yield* task; // join so the run's finally (HTTP abort) runs
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
                // Record the steer in this turn's detailed trace and add it to
                // the context so the rerun (and the model) sees it. (The Agent
                // also records it in the general conversation.)
                yield* sendClient(Turn, turnId).append({
                  role: "user",
                  text: steer,
                });
                context = [...context, {role: "user", content: steer}];
                break;
              }
            }
          }
        } catch (err) {
          // The run failed terminally (model/tool error, truncated recovery,
          // step budget). Record it instead of letting the turn die silently.
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
