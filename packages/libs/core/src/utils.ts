import OpenAI from "openai";
import type {LLMChunk} from "./agent_framework";

// The framework talks to the model in a small streaming protocol: the model
// emits a sequence of compact JSON objects, each one an `LLMChunk`, so the agent
// can act on each the moment it completes instead of waiting for the whole reply.
//
// The streaming implementation is adapted from the `signal-stream-example`
// reference: accumulate token deltas and drain every *complete* top-level JSON
// object out of the buffer as it arrives. This raw stream is non-replayable (a
// re-run would call the model again and get different tokens); the framework
// consumes it through `StepContext.prompt` (see service.ts), which journals each
// chunk it pulls and replays them verbatim after a crash.

// The chat model to use. Any streaming-capable OpenAI chat model works.
const MODEL = "gpt-4o";

const SYSTEM = [
  "You are an agent that streams its work as a sequence of JSON objects.",
  "Emit one compact JSON object per step. No prose, no markdown fences.",
  "Each object must be exactly one of:",
  '{"type":"text","content":"..."} for anything you say, or',
  '{"type":"tool_call","name":"...","args":{"key":"value"}} to call a tool.',
  "All args values must be strings.",
].join(" ");

// Lazily construct the client so importing the framework doesn't require the API
// key until a prompt actually runs. Reads OPENAI_API_KEY from the environment.
let client: OpenAI | undefined;
function openai(): OpenAI {
  client ??= new OpenAI();
  return client;
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

export async function* llmFetch(prompt: string): AsyncGenerator<LLMChunk> {
  const stream = await openai().chat.completions.create({
    model: MODEL,
    stream: true,
    messages: [
      {role: "system", content: SYSTEM},
      {role: "user", content: prompt},
    ],
  });

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
