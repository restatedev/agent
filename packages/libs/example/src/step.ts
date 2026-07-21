// The model-round engine: one durable round of "pull a completion, parse it,
// run its tools, report what happened". This file is deliberately
// self-contained — it never imports the example's model or tools. Everything
// application-specific reaches modelStep() through the ModelRound interface,
// so swapping the model, the reply protocol, the toolset, or the trace
// destination changes the binding (see ./turn), never the engine.

import {durableSource} from "@restate-agents/core";
import {TerminalError} from "@restatedev/restate-sdk";
import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Message} from "./types";

// A message in the model's context window. `tool` carries a tool's result back
// into the next inference so the model can act on it (a closed
// model->tool->model loop).
export type ModelMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
};

// One tool invocation as the model requests it.
export type ToolCall = {name: string; args: Record<string, string>};

// One protocol step of a parsed model reply: text to surface, or a tool call
// to execute. This is the shape ModelRound.parse must produce — the example's
// zod schema (see ./model) validates into exactly this.
export type ModelChunk =
  | {type: "text"; content: string}
  | ({type: "tool_call"} & ToolCall);

// How the engine reports one detailed trace message. Bound once per turn (to
// the conversation and turn ids, see ./turn) and threaded through the loop, so
// neither the engine nor the loop's stages need to know where the trace lives.
// The result is ignored — reporting is fire-and-forget.
export type Reporter = (entry: Message) => Operation<unknown>;

// Everything one model round needs, provided by the application.
export type ModelRound = {
  // Start one raw completion stream for `messages`. It may be non-replayable —
  // modelStep journals every pull via durableSource. `signal` aborts the
  // underlying request when the step is interrupted.
  fetch(messages: ModelMessage[], signal: AbortSignal): AsyncGenerator<string>;
  // Parse a full raw reply into protocol chunks. Throw on any protocol
  // violation — modelStep turns the throw into a recoverable {error} the model
  // gets fed back, so be loud, not lenient.
  parse(raw: string): ModelChunk[];
  // Execute one tool call, returning the result string for the model. Return
  // tool failures as `error: ...` strings (recoverable, fed back); only throw
  // for failures that must end the turn (e.g. an interrupt).
  runTool(call: ToolCall): Operation<string>;
  // Report one trace message.
  report: Reporter;
};

// The outcome of one model round: either the model's text plus any tool
// results, or a recoverable error to feed back to the model so it can
// self-correct.
export type StepOutcome =
  | {text: string; tools: (ToolCall & {result: string})[]}
  | {error: string};

// One model round: durably pull the raw completion, then parse and run it.
// Parsing happens OUTSIDE the durable pull, so a malformed response is a
// recoverable `{error}` (fed back to the model) rather than a terminal failure.
// Interrupts and genuine stream failures surface from the pull and propagate.
export function* modelStep(
  round: ModelRound,
  messages: ModelMessage[],
): Operation<StepOutcome> {
  // Own the abort so an interrupt tears down the in-flight HTTP stream, not just
  // the Restate task. The finally fires on normal completion and on the throw
  // that task.interrupt() injects mid-stream.
  const controller = new AbortController();
  let raw = "";
  try {
    const stream = yield* durableSource(() =>
      round.fetch(messages, controller.signal),
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
  let chunks: ModelChunk[];
  try {
    chunks = round.parse(raw);
  } catch (err) {
    return {error: err instanceof Error ? err.message : String(err)};
  }

  let text = "";
  const tools: (ToolCall & {result: string})[] = [];
  for (const chunk of chunks) {
    if (chunk.type === "tool_call") {
      const result = yield* round.runTool(chunk);
      yield* round.report({
        role: "tool",
        text: `${chunk.name}(${JSON.stringify(chunk.args)}) → ${result}`,
      });
      tools.push({name: chunk.name, args: chunk.args, result});
    } else if (chunk.content) {
      text += chunk.content;
      yield* round.report({role: "assistant", text: chunk.content});
    }
  }
  return {text, tools};
}
