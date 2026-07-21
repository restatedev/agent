// The concrete agent loop for the example. It owns the complete
// model -> tools -> model cycle: the OpenAI prompt and transport, the response
// protocol, durable model calls, tool execution, error feedback, and the round
// budget. Keeping those pieces together makes their coupling explicit — the
// prompt promises exactly the protocol parsed below, and the loop consumes
// exactly that protocol.
//
// The surrounding Turn service only supervises this work. It supplies the
// conversation context and races the loop against interrupt and steering
// signals.

import {TerminalError} from "@restatedev/restate-sdk";
import {
  client,
  InterruptedError,
  type Operation,
  run,
} from "@restatedev/restate-sdk-gen";
import OpenAI from "openai";
import {z} from "zod";
import {Weather} from "./weather";

// A message in the model's context window. Tool messages carry results back
// into the next inference so the model can act on them.
export type ModelMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
};

export type AgentLoopResult =
  | {status: "completed"; text: string}
  | {status: "failed"; error: string};

const ModelActionSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("text"), content: z.string()}),
  z.object({
    type: z.literal("tool_call"),
    name: z.string(),
    args: z.record(z.string(), z.string()),
  }),
]);
type ModelAction = z.infer<typeof ModelActionSchema>;
type ToolCall = Extract<ModelAction, {type: "tool_call"}>;
type ModelResult = ModelAction | {type: "error"; message: string};

const MODEL = "gpt-4o";
const MAX_ROUNDS = 8;

const SYSTEM = [
  "You are an agent that works in steps. Reply with exactly one compact JSON",
  "object, with no prose or markdown fences. It must be one of:",
  '{"type":"text","content":"..."} for anything you say, or',
  '{"type":"tool_call","name":"...","args":{"key":"value"}} to call a tool.',
  "The only tool is getWeather(city). All arg values must be strings.",
  "When you call a tool, stop; its result arrives next as a user message prefixed",
  '\'tool_result:\'. Once you have what you need, emit a single {"type":"text"}',
  "with your final answer and no further tool_call.",
].join(" ");

let modelClient: OpenAI | undefined;

// Restate owns retries for model calls. Retry transport failures, timeouts,
// rate limits, conflicts, and server failures; fail fast for deterministic
// request/configuration errors.
export function isRetryableModelStatus(status: number | undefined): boolean {
  return (
    status === undefined ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}

// One model round is one durable side effect. There is no streaming adapter or
// resumable-source machinery: Restate journals the single validated action.
// Protocol mistakes are returned as values so the loop can ask the model to
// correct itself; transport failures still throw and follow `run` retry policy.
function* model(messages: ModelMessage[]): Operation<ModelResult> {
  return yield* run(
    async ({signal}): Promise<ModelResult> => {
      if (!process.env.OPENAI_API_KEY) {
        throw new TerminalError("OPENAI_API_KEY is not set");
      }

      // Disable the library's hidden retries so Restate journals and controls
      // the complete retry policy.
      modelClient ??= new OpenAI({maxRetries: 0});

      let completion: OpenAI.ChatCompletion;
      try {
        completion = await modelClient.chat.completions.create(
          {
            model: MODEL,
            response_format: {type: "json_object"},
            messages: [
              {role: "system", content: SYSTEM},
              ...messages.map(
                (message): OpenAI.ChatCompletionMessageParam =>
                  message.role === "tool"
                    ? {role: "user", content: `tool_result: ${message.content}`}
                    : {role: message.role, content: message.content},
              ),
            ],
          },
          {signal},
        );
      } catch (error) {
        if (
          error instanceof OpenAI.APIError &&
          !isRetryableModelStatus(error.status)
        ) {
          throw new TerminalError(
            `OpenAI rejected the request: ${error.message}`,
            {
              errorCode: error.status,
            },
          );
        }
        throw error;
      }

      const raw = completion.choices[0]?.message.content ?? "";
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return {type: "error", message: `model emitted invalid JSON: ${raw}`};
      }
      const parsed = ModelActionSchema.safeParse(value);
      if (!parsed.success) {
        return {
          type: "error",
          message: `model emitted an unrecognized action: ${raw}`,
        };
      }
      return parsed.data;
    },
    {
      name: "model",
      retry: {
        maxAttempts: 4,
        initialInterval: 500,
        maxInterval: 5_000,
        exponentiationFactor: 2,
      },
    },
  );
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
    // The tool call is a durable service invocation, not an opaque local
    // callback hidden inside the Turn's journal.
    const weather = yield* client(Weather).get({city});
    return `${weather.temperatureCelsius}°C, ${weather.condition} in ${weather.city}`;
  } catch (error) {
    if (error instanceof InterruptedError || error instanceof TerminalError) {
      throw error;
    }
    return `error: getWeather failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function observe(messages: ModelMessage[], note: string): void {
  messages.push({role: "user", content: note});
}

// Run model -> tools -> model until there is a final answer. The only injected
// input is conversation context; the example's model and tools are concrete
// parts of this loop rather than ceremonial dependencies.
export function* agentLoop(
  context: ModelMessage[],
): Operation<AgentLoopResult> {
  const messages = [...context];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const action = yield* model(messages);

    if (action.type === "error") {
      observe(
        messages,
        `Your last response could not be used (${action.message}). Reply with valid protocol JSON.`,
      );
      continue;
    }

    if (action.type === "text") {
      if (!action.content) {
        observe(
          messages,
          "Your last response was empty. Call a tool or give a final answer.",
        );
        continue;
      }
      return {status: "completed", text: action.content};
    }

    const result = yield* runTool(action);
    messages.push({
      role: "assistant",
      content: JSON.stringify(action),
    });
    messages.push({role: "tool", content: `${action.name}: ${result}`});
  }

  return {
    status: "failed",
    error: `agent did not finish within ${MAX_ROUNDS} rounds`,
  };
}
