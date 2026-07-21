// The agent loop — the brain of a turn. One call to agentLoop() drives the
// closed model -> tools -> model cycle for one instruction: durably pull a
// completion, parse it, execute the tools it asks for, feed the results (and
// any recoverable model mistakes) back, and go again, until the model gives a
// final answer. Bounded by MAX_ROUNDS so a model that keeps calling tools —
// or keeps producing junk — can't spin forever.
//
// The loop is deliberately self-contained — it never imports the example's
// model or tools. Everything application-specific arrives through LoopDeps:
//
//   - model    the language model as ONE interface: stream a raw completion,
//              parse a complete reply into protocol chunks. One interface and
//              not two dependencies, because they are two halves of a single
//              contract — parse() decodes exactly the protocol the model's
//              prompting promises — so an implementation keeps them together
//              (see ./model) where they cannot drift apart.
//   - runTool  execute one tool call, returning the result for the model.
//   - report   file one trace message with the conversation (fire-and-forget).
//
// Swap any of them and the brain is unchanged.

import {durableSource} from "@restate-agents/core";
import {TerminalError} from "@restatedev/restate-sdk";
import type {Operation} from "@restatedev/restate-sdk-gen";
import type {Message} from "./types";

// A message in the model's context window. `tool` carries a tool's result back
// into the next inference so the model can act on it.
export type ModelMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
};

// One tool invocation as the model requests it.
export type ToolCall = {name: string; args: Record<string, string>};

// One protocol step of a parsed model reply: text to surface, or a tool call
// to execute. This is the shape Model.parse must produce — the example's zod
// schema (see ./model) validates into exactly this.
export type ModelChunk =
  | {type: "text"; content: string}
  | ({type: "tool_call"} & ToolCall);

// How the loop reports one detailed trace message. Bound once per turn (to
// the conversation, see ./turn) and threaded through the loop, so no stage
// needs to know where the trace lives. The result is ignored — reporting is
// fire-and-forget.
export type Reporter = (entry: Message) => Operation<unknown>;

// The language model as the loop consumes it: two halves of one contract,
// kept in one interface so they are implemented — and swapped — together.
export type Model = {
  // Start one raw completion stream for `messages`. It may be non-replayable —
  // the loop journals every pull via durableSource. `signal` is owned by the
  // durable source and fires when a pull is interrupted; pass it into the
  // underlying request so an interrupt tears the stream down immediately.
  stream(messages: ModelMessage[], signal: AbortSignal): AsyncGenerator<string>;
  // Parse a full raw reply into protocol chunks. Throw on any protocol
  // violation — the loop turns the throw into a recoverable mistake the model
  // gets fed back, so be loud, not lenient.
  parse(raw: string): ModelChunk[];
};

// Everything one turn's loop needs, provided by the application.
export type LoopDeps = {
  model: Model;
  // Execute one tool call, returning the result string for the model. Return
  // tool failures as `error: ...` strings (recoverable, fed back); only throw
  // for failures that must end the turn (e.g. an interrupt).
  runTool(call: ToolCall): Operation<string>;
  report: Reporter;
};

// Bound on the loop: model rounds, including error-feedback retries.
const MAX_ROUNDS = 8;

// The outcome of one model round: either the model's text plus any tool
// results, or a recoverable error to feed back to the model so it can
// self-correct.
type StepOutcome =
  | {text: string; tools: (ToolCall & {result: string})[]}
  | {error: string};

// One model round: durably pull the raw completion, then parse and run it.
// Parsing happens OUTSIDE the durable pull, so a malformed response is a
// recoverable `{error}` (fed back to the model) rather than a terminal failure.
// Interrupts and genuine stream failures surface from the pull and propagate;
// tearing down the underlying request is durableSource's job — it forwards an
// interrupted pull's abort into the signal it handed the model stream.
function* modelStep(
  deps: LoopDeps,
  messages: ModelMessage[],
): Operation<StepOutcome> {
  const stream = yield* durableSource((signal) =>
    deps.model.stream(messages, signal),
  );
  let raw = "";
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

  // Parse outside the durable pull: a malformed response is the model's mistake,
  // recoverable by feeding it back — not a terminal stream error.
  let chunks: ModelChunk[];
  try {
    chunks = deps.model.parse(raw);
  } catch (err) {
    return {error: err instanceof Error ? err.message : String(err)};
  }

  let text = "";
  const tools: (ToolCall & {result: string})[] = [];
  for (const chunk of chunks) {
    if (chunk.type === "tool_call") {
      const result = yield* deps.runTool(chunk);
      yield* deps.report({
        role: "tool",
        text: `${chunk.name}(${JSON.stringify(chunk.args)}) → ${result}`,
      });
      tools.push({name: chunk.name, args: chunk.args, result});
    } else if (chunk.content) {
      text += chunk.content;
      yield* deps.report({role: "assistant", text: chunk.content});
    }
  }
  return {text, tools};
}

// Feed a recoverable error/observation back to the model and record it in the
// turn's trace, so the next round can self-correct.
function* observe(
  deps: LoopDeps,
  messages: ModelMessage[],
  note: string,
): Operation<void> {
  messages.push({role: "user", content: note});
  yield* deps.report({role: "tool", text: note});
}

// Run the agent loop for one instruction: model -> tools -> model until the
// model answers with no tool call. A recoverable model mistake — a malformed
// response or an empty one — is fed back as an observation so the model
// self-corrects next round rather than failing the turn. Bounded by MAX_ROUNDS.
export function* agentLoop(
  deps: LoopDeps,
  context: ModelMessage[],
): Operation<string> {
  const messages = [...context];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const step = yield* modelStep(deps, messages);

    if ("error" in step) {
      yield* observe(
        deps,
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
        deps,
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
