// The example's model. This is deliberately example-specific and self-contained
// — the framework only cares about a stream of chunks (see `durableSource` in
// @restate-agents/core); it does not care that they come from an LLM. Swap this
// file for any other streaming source and the turn loop is unchanged.
//
// Set OPENAI_API_KEY in the environment before running.

import OpenAI from "openai";
import {z} from "zod";

// One protocol step from the model. The model speaks a small protocol: its reply
// is a sequence of compact JSON objects, each one an `LLMChunk`. The raw text is
// streamed durably (llmFetch) and parsed afterwards (parseProgram). The schema is
// enforced on every parsed object (see drainObjects) — the model's output is
// untrusted, so a malformed chunk is a clear protocol error, not a value cast
// blindly to this type.
export const LLMChunkSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("text"), content: z.string()}),
  z.object({
    type: z.literal("tool_call"),
    name: z.string(),
    args: z.record(z.string(), z.string()),
  }),
]);
export type LLMChunk = z.infer<typeof LLMChunkSchema>;

// A message in the model's context window. `tool` carries a tool's result back
// into the next inference so the model can act on it (a closed model->tool->model
// loop).
export type ModelMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
};

// The chat model to use. Any streaming-capable OpenAI chat model works.
const MODEL = "gpt-4o";

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

// Lazily construct the client so importing the example doesn't require the API
// key until a prompt actually runs. Reads OPENAI_API_KEY from the environment.
let client: OpenAI | undefined;
function openai(): OpenAI {
  client ??= new OpenAI();
  return client;
}

// Map our compact ModelMessage onto the OpenAI chat roles. We use a plain-text
// tool protocol (JSON objects in the stream) rather than OpenAI's native tool
// calling, so a tool result is fed back as a prefixed user message.
function toChatMessage(m: ModelMessage): OpenAI.ChatCompletionMessageParam {
  if (m.role === "tool") {
    return {role: "user", content: `tool_result: ${m.content}`};
  }
  return {role: m.role, content: m.content};
}

// Parse one complete JSON object and validate it against the chunk protocol.
// The model is untrusted, so bad JSON or an unrecognized shape is a clear
// protocol error rather than a value quietly cast to LLMChunk.
function parseChunk(slice: string): LLMChunk {
  let value: unknown;
  try {
    value = JSON.parse(slice);
  } catch {
    throw new Error(`model emitted invalid JSON: ${slice}`);
  }
  const result = LLMChunkSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`model emitted an unrecognized chunk: ${slice}`);
  }
  return result.data;
}

// Pull every complete top-level JSON object out of `buf`, returning the parsed
// chunks and the not-yet-complete remainder. We track brace depth (respecting
// strings/escapes) instead of trusting a delimiter, because the model is not
// reliable about putting exactly one object per line.
function drainObjects(buf: string): {chunks: LLMChunk[]; rest: string} {
  const chunks: LLMChunk[] = [];
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
      // Outside any object only whitespace is allowed. Prose, markdown fences, or
      // any stray token is a protocol violation — surface it rather than drop it
      // silently (which would otherwise show up later as an empty answer).
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
  // Keep from the start of an in-progress object; otherwise we've consumed it all.
  return {chunks, rest: start === -1 ? "" : buf.slice(start)};
}

// Parse the model's full response text into protocol chunks. Called OUTSIDE the
// durable model pull (see modelStep), so a malformed response is a recoverable
// model mistake the agent can feed back — not a terminal stream failure. Throws
// on non-JSON output (via drainObjects), an incomplete trailing object, or an
// empty response.
export function parseProgram(raw: string): LLMChunk[] {
  const {chunks, rest} = drainObjects(raw);
  if (rest.trim().length > 0) {
    throw new Error(`response ended with incomplete JSON: ${rest}`);
  }
  if (chunks.length === 0) {
    throw new Error("response contained no JSON objects");
  }
  return chunks;
}

// Stream a completion for `messages`, yielding the raw text deltas. Parsing is
// deliberately left to parseProgram (run outside the durable pull). The `signal`
// aborts the underlying HTTP request, so interrupting a turn tears down the
// in-flight stream instead of leaving it draining.
export async function* llmFetch(
  messages: ModelMessage[],
  signal?: AbortSignal,
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
