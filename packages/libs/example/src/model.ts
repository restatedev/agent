// The example's model. This is deliberately example-specific and self-contained
// — the framework only cares about a stream of chunks (see `durableSource` in
// @restate-agents/core); it does not care that they come from an LLM. Swap this
// file for any other streaming source and the turn loop is unchanged.
//
// Set OPENAI_API_KEY in the environment before running.

import OpenAI from "openai";

// A single streamed step from the model. The model speaks a small protocol: it
// emits a sequence of compact JSON objects, each one an `LLMChunk`, so a caller
// can act on each the moment it completes instead of waiting for the whole reply.
export type LLMChunk =
  | {type: "text"; content: string}
  | {type: "tool_call"; name: string; args: Record<string, string>};

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
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        chunks.push(JSON.parse(buf.slice(start, i + 1)) as LLMChunk);
        start = -1;
      }
    }
  }
  // Keep from the start of an in-progress object; otherwise we've consumed it all.
  return {chunks, rest: start === -1 ? "" : buf.slice(start)};
}

// Stream a completion for `messages`. The `signal` aborts the underlying HTTP
// request, so interrupting a turn actually tears down the in-flight stream
// instead of leaving it draining.
export async function* llmFetch(
  messages: ModelMessage[],
  signal?: AbortSignal,
): AsyncGenerator<LLMChunk> {
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

  let buffer = "";
  for await (const part of stream) {
    buffer += part.choices[0]?.delta?.content ?? "";
    const {chunks, rest} = drainObjects(buffer);
    buffer = rest;
    for (const chunk of chunks) yield chunk;
  }
  // Drain any final complete object left in the buffer.
  for (const chunk of drainObjects(buffer).chunks) yield chunk;
}
