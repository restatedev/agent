// The concrete agent loop for the example. It owns the complete
// model -> tools -> model cycle: the OpenAI prompt and transport, the response
// protocol, durable streaming, tool execution, error feedback, and the round
// budget. Keeping those pieces together makes their coupling explicit — the
// prompt promises exactly the protocol parsed below, and the loop consumes
// exactly that protocol.
//
// The surrounding Turn service only supervises this work. It supplies the
// conversation context and a trace reporter, then races the loop against the
// interrupt and steering signals.

import {setTimeout} from "node:timers/promises";
import {durableSource} from "@restate-agents/core";
import {TerminalError} from "@restatedev/restate-sdk";
import {
  InterruptedError,
  type Operation,
  run,
} from "@restatedev/restate-sdk-gen";
import OpenAI from "openai";
import {z} from "zod";
import type {Message} from "./types";

// A message in the model's context window. Tool messages carry results back
// into the next inference so the model can act on them.
export type ModelMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
};

// The Turn binds this to Agent.appendTrace for the current conversation.
export type Reporter = (entry: Message) => Operation<unknown>;

type ToolCall = {name: string; args: Record<string, string>};
type ModelChunk =
  | {type: "text"; content: string}
  | ({type: "tool_call"} & ToolCall);

const ModelChunkSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("text"), content: z.string()}),
  z.object({
    type: z.literal("tool_call"),
    name: z.string(),
    args: z.record(z.string(), z.string()),
  }),
]);

const MODEL = "gpt-4o";
const MAX_ROUNDS = 8;

const SYSTEM = [
  "You are an agent that works in steps, emitting compact JSON objects — one per",
  "step, no prose, no markdown fences. Each object must be exactly one of:",
  '{"type":"text","content":"..."} for anything you say, or',
  '{"type":"tool_call","name":"...","args":{"key":"value"}} to call a tool.',
  "The only tool is getWeather(city). All arg values must be strings.",
  "When you call a tool, stop; its result arrives next as a user message prefixed",
  '\'tool_result:\'. Once you have what you need, emit a single {"type":"text"}',
  "with your final answer and no further tool_call.",
].join(" ");

// Construct the client lazily so importing the service does not require the
// API key until a turn actually reaches the model.
let client: OpenAI | undefined;
function openai(): OpenAI {
  client ??= new OpenAI();
  return client;
}

function toChatMessage(
  message: ModelMessage,
): OpenAI.ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {role: "user", content: `tool_result: ${message.content}`};
  }
  return {role: message.role, content: message.content};
}

// Stream raw text deltas. durableSource journals every pull and supplies the
// signal that aborts the underlying HTTP request when the loop is interrupted.
async function* streamModel(
  messages: ModelMessage[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  const stream = await openai().chat.completions.create(
    {
      model: MODEL,
      stream: true,
      messages: [
        {role: "system", content: SYSTEM},
        ...messages.map(toChatMessage),
      ],
    },
    {signal},
  );

  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content ?? "";
    if (delta) {
      yield delta;
    }
  }
}

function parseChunk(slice: string): ModelChunk {
  let value: unknown;
  try {
    value = JSON.parse(slice);
  } catch {
    throw new Error(`model emitted invalid JSON: ${slice}`);
  }
  const result = ModelChunkSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`model emitted an unrecognized chunk: ${slice}`);
  }
  return result.data;
}

// Extract complete top-level JSON objects while respecting braces inside
// strings. Any non-whitespace outside an object is a protocol violation.
function drainObjects(buf: string): {chunks: ModelChunk[]; rest: string} {
  const chunks: ModelChunk[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (depth === 0) {
      if (!/\s/.test(ch)) {
        throw new Error(
          `model emitted non-JSON output: ${JSON.stringify(buf.slice(i))}`,
        );
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        chunks.push(parseChunk(buf.slice(start, i + 1)));
        start = -1;
      }
    }
  }

  return {chunks, rest: start === -1 ? "" : buf.slice(start)};
}

function parseProgram(raw: string): ModelChunk[] {
  const {chunks, rest} = drainObjects(raw);
  if (rest.trim().length > 0) {
    throw new Error(`response ended with incomplete JSON: ${rest}`);
  }
  if (chunks.length === 0) {
    throw new Error("response contained no JSON objects");
  }
  return chunks;
}

// The example tool is deliberately local and small. A real application can
// replace this switch with a registry or service invocations without changing
// the Turn lifecycle.
async function getWeather(city: string, signal: AbortSignal) {
  await setTimeout(200, undefined, {signal});
  return {city, temp: 22, condition: "sunny"};
}

function* runTool(call: ToolCall): Operation<string> {
  if (call.name !== "getWeather") {
    return `error: unknown tool "${call.name}"`;
  }
  const city = call.args.city;
  if (!city) {
    return 'error: getWeather requires a string "city" arg';
  }

  try {
    const weather = yield* run((opts) => getWeather(city, opts.signal), {
      name: "getWeather",
    });
    return `${weather.temp}°C, ${weather.condition} in ${weather.city}`;
  } catch (error) {
    if (error instanceof InterruptedError) {
      throw error;
    }
    return `error: getWeather failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

type StepOutcome =
  | {text: string; tools: (ToolCall & {result: string})[]}
  | {error: string};

// One durable model round. Parsing remains outside the durable source pull so
// malformed model output is recoverable feedback, while transport failures and
// truncated recovery remain terminal.
function* modelStep(
  messages: ModelMessage[],
  report: Reporter,
): Operation<StepOutcome> {
  const stream = yield* durableSource((signal) =>
    streamModel(messages, signal),
  );
  let raw = "";
  while (true) {
    const result = yield* stream.next();
    if (result.type === "done") {
      break;
    }
    if (result.type === "aborted") {
      throw new TerminalError("model response was truncated on recovery");
    }
    raw += result.value;
  }

  let chunks: ModelChunk[];
  try {
    chunks = parseProgram(raw);
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error)};
  }

  let text = "";
  const tools: (ToolCall & {result: string})[] = [];
  for (const chunk of chunks) {
    if (chunk.type === "tool_call") {
      const result = yield* runTool(chunk);
      yield* report({
        role: "tool",
        text: `${chunk.name}(${JSON.stringify(chunk.args)}) → ${result}`,
      });
      tools.push({name: chunk.name, args: chunk.args, result});
    } else if (chunk.content) {
      text += chunk.content;
      yield* report({role: "assistant", text: chunk.content});
    }
  }
  return {text, tools};
}

function* observe(
  messages: ModelMessage[],
  report: Reporter,
  note: string,
): Operation<void> {
  messages.push({role: "user", content: note});
  yield* report({role: "tool", text: note});
}

// Run model -> tools -> model until there is a final answer. The only injected
// behavior is the turn-scoped trace destination; the example's model and tools
// are concrete parts of this loop rather than ceremonial dependencies.
export function* agentLoop(
  context: ModelMessage[],
  report: Reporter,
): Operation<string> {
  const messages = [...context];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const step = yield* modelStep(messages, report);

    if ("error" in step) {
      yield* observe(
        messages,
        report,
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
        return text;
      }
      yield* observe(
        messages,
        report,
        "Your last response was empty. Call a tool or give a final answer.",
      );
      continue;
    }

    for (const tool of tools) {
      messages.push({
        role: "assistant",
        content: JSON.stringify({
          type: "tool_call",
          name: tool.name,
          args: tool.args,
        }),
      });
      messages.push({
        role: "tool",
        content: `${tool.name}: ${tool.result}`,
      });
    }
  }

  throw new TerminalError(`agent did not finish within ${MAX_ROUNDS} rounds`);
}
