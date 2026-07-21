// Everything specific to model access lives here: the wire protocol used by
// the agent loop, the cheap message router, and the scoped model gateway.

import {createHash} from "node:crypto";
import {Opts, TerminalError} from "@restatedev/restate-sdk";
import {
  type Operation,
  run,
  schemas,
  scope,
  service,
} from "@restatedev/restate-sdk-gen";
import OpenAI from "openai";
import {z} from "zod";

const ModelMessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
});
export type ModelMessage = z.infer<typeof ModelMessageSchema>;

const ToolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.string()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

const ModelActionSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("text"), content: z.string()}),
  z.object({
    type: z.literal("tool_calls"),
    calls: z.array(ToolCallSchema).min(1).max(10),
  }),
]);
const ModelResultSchema = z.union([
  ModelActionSchema,
  z.object({type: z.literal("error"), message: z.string()}),
]);
type ModelResult = z.infer<typeof ModelResultSchema>;

const MessageRouteSchema = z.enum(["steer", "interrupt", "queue"]);
export type MessageRoute = z.infer<typeof MessageRouteSchema>;
const RouteResponseSchema = z.object({route: MessageRouteSchema});

const ModelRequestSchema = z.object({messages: z.array(ModelMessageSchema)});

const AGENT_MODEL = "gpt-5.6-terra";
const ROUTER_MODEL = "gpt-4o-mini";
const MODEL_SCOPE = "openai";

const AGENT_SYSTEM = [
  "You are an agent that works in steps. Reply with exactly one compact JSON",
  "object, with no prose or markdown fences. It must be one of:",
  '{"type":"text","content":"..."} for a final answer, or',
  '{"type":"tool_calls","calls":[{"name":"...","args":{"key":"value"}}]}',
  "to call between 1 and 10 independent tools in parallel.",
  "The only tool is getWeather(city). All arg values must be strings.",
  "Group independent calls into one tool_calls action. After calling tools, stop;",
  "their results arrive next as user messages prefixed with 'tool_result:'.",
  "Once you have what you need, emit one text action.",
].join(" ");

const ROUTER_SYSTEM = [
  "Another agent turn is currently running. Classify the new user message.",
  'Reply with exactly one JSON object: {"route":"steer|interrupt|queue"}.',
  "Use interrupt only for an explicit request to stop or cancel current work.",
  "Use steer for corrections or refinements intended to change current work.",
  "Use queue for a separate request, a follow-up that can wait, or uncertainty.",
].join(" ");

let client: OpenAI | undefined;

function isRetryableStatus(status: number | undefined): boolean {
  return (
    status === undefined ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}

async function completeJson(
  model: string,
  system: string,
  messages: ModelMessage[],
  signal: AbortSignal,
): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new TerminalError("OPENAI_API_KEY is not set");
  }

  // Restate owns retries, so the OpenAI client must not retry invisibly.
  client ??= new OpenAI({maxRetries: 0});

  try {
    const completion = await client.chat.completions.create(
      {
        model,
        reasoning_effort: model === ROUTER_MODEL ? undefined : "low",
        response_format: {type: "json_object"},
        messages: [
          {role: "system", content: system},
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
    return completion.choices[0]?.message.content ?? "";
  } catch (error) {
    if (error instanceof OpenAI.APIError && !isRetryableStatus(error.status)) {
      throw new TerminalError(`OpenAI rejected the request: ${error.message}`, {
        errorCode: error.status,
      });
    }
    throw error;
  }
}

function parseAction(raw: string): ModelResult {
  try {
    const parsed = ModelActionSchema.safeParse(JSON.parse(raw));
    return parsed.success
      ? parsed.data
      : {
          type: "error",
          message: `model emitted an unrecognized action: ${raw}`,
        };
  } catch {
    return {type: "error", message: `model emitted invalid JSON: ${raw}`};
  }
}

// This fast classification runs directly in the Agent handler. If it fails,
// the Agent conservatively queues the message rather than losing it.
export function* routeMessage(message: string): Operation<MessageRoute> {
  return yield* run(
    async ({signal}): Promise<MessageRoute> => {
      const raw = await completeJson(
        ROUTER_MODEL,
        ROUTER_SYSTEM,
        [{role: "user", content: message}],
        signal,
      );
      try {
        const parsed = RouteResponseSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data.route : "queue";
      } catch {
        return "queue";
      }
    },
    {
      name: "route-message",
      retry: {maxAttempts: 2, initialInterval: 100, maxInterval: 500},
    },
  );
}

// The main model call is a service so Restate can apply scope-based concurrency
// control before the expensive OpenAI request starts.
export const ModelGateway = service({
  name: "ModelGateway",
  handlers: {
    complete: schemas(
      {input: ModelRequestSchema, output: ModelResultSchema},
      function* ({messages}): Operation<ModelResult> {
        return yield* run(
          async ({signal}) =>
            parseAction(
              await completeJson(AGENT_MODEL, AGENT_SYSTEM, messages, signal),
            ),
          {
            name: "agent-model",
            retry: {
              maxAttempts: 4,
              initialInterval: 500,
              maxInterval: 5_000,
              exponentiationFactor: 2,
            },
          },
        );
      },
    ),
  },
  options: {handlers: {complete: {ingressPrivate: true}}},
});

function agentLimitKey(agentId: string): string {
  const agent = createHash("sha256").update(agentId).digest("hex").slice(0, 24);
  return `${AGENT_MODEL}/${agent}`;
}

// Only the agent loop goes through the scoped gateway. The `openai` scope is
// the provider-wide budget; the two limit-key levels are model and agent.
export function* model(
  agentId: string,
  messages: ModelMessage[],
): Operation<ModelResult> {
  return yield* scope(MODEL_SCOPE)
    .client(ModelGateway)
    .complete(
      {messages},
      Opts.from({limitKey: agentLimitKey(agentId), name: "agent-model"}),
    );
}
