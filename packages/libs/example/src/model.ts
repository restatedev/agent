// Everything specific to model access lives here: model selection, tool
// definitions, the cheap message router, and the scoped model gateway.

import {createHash} from "node:crypto";
import {createOpenAI, type OpenAIProvider} from "@ai-sdk/openai";
import {Opts, TerminalError} from "@restatedev/restate-sdk";
import {
  type Operation,
  run,
  schemas,
  scope,
  service,
} from "@restatedev/restate-sdk-gen";
import {
  APICallError,
  assistantModelMessageSchema,
  generateText,
  jsonSchema,
  type ModelMessage,
  modelMessageSchema,
  Output,
  type ToolSet,
} from "ai";
import {z} from "zod";

const ToolManifestSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

const ToolCallSchema = z.object({
  type: z.literal("tool-call"),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;
const ToolCallsSchema = z.array(ToolCallSchema).min(1);

const ModelResultSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("text"), content: z.string()}),
  z.object({
    type: z.literal("tool_calls"),
    message: assistantModelMessageSchema,
    calls: ToolCallsSchema,
  }),
  z.object({type: z.literal("error"), message: z.string()}),
]);
export type ModelResult = z.infer<typeof ModelResultSchema>;

const MESSAGE_ROUTES = ["steer", "interrupt", "queue"] as const;
export type MessageRoute = (typeof MESSAGE_ROUTES)[number];

const ModelRequestSchema = z.object({
  messages: z.array(modelMessageSchema),
  tools: z.array(ToolManifestSchema).min(1),
});

const AGENT_MODEL = "gpt-5.6-terra";
const ROUTER_MODEL = "gpt-4o-mini";
const MODEL_SCOPE = "openai";

const AGENT_SYSTEM = [
  "You are a concise assistant.",
  "Use the available tools whenever they are needed to fulfill the request.",
  "Group independent tool calls in one response so they can run in parallel.",
  "After receiving tool results, answer the user's request directly.",
].join(" ");

const ROUTER_SYSTEM = [
  "Another agent turn is currently running. Classify the new user message.",
  "Use interrupt only for an explicit request to stop or cancel current work.",
  "Use steer for corrections or refinements intended to change current work.",
  "Use queue for a separate request, a follow-up that can wait, or uncertainty.",
].join(" ");

let provider: OpenAIProvider | undefined;

function openAI(): OpenAIProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new TerminalError("OPENAI_API_KEY is not set");
  }
  if (!provider) {
    provider = createOpenAI({apiKey});
  }
  return provider;
}

async function withOpenAI<T>(
  call: (provider: OpenAIProvider) => Promise<T>,
): Promise<T> {
  try {
    return await call(openAI());
  } catch (error) {
    // Restate owns retries. Invalid requests and authentication failures are
    // terminal; throttling and transient provider failures remain retryable.
    if (APICallError.isInstance(error) && !error.isRetryable) {
      throw new TerminalError(`OpenAI rejected the request: ${error.message}`, {
        errorCode: error.statusCode,
      });
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "value";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

async function completeAgent(
  messages: ModelMessage[],
  tools: ToolManifest[],
  signal: AbortSignal,
): Promise<ModelResult> {
  return withOpenAI(async (openai) => {
    const modelTools: ToolSet = Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        {
          description: tool.description,
          // Tool manifests are produced from Zod's draft-07 JSON Schema output
          // in agent-loop. The gateway deliberately receives no executors.
          inputSchema: jsonSchema(
            tool.inputSchema as Parameters<typeof jsonSchema>[0],
          ),
          strict: true,
        },
      ]),
    );
    const result = await generateText({
      model: openai.responses(AGENT_MODEL),
      system: AGENT_SYSTEM,
      messages,
      tools: modelTools,
      toolChoice: "auto",
      maxOutputTokens: 2_000,
      maxRetries: 0,
      abortSignal: signal,
      timeout: 120_000,
      providerOptions: {
        openai: {
          reasoningEffort: "low",
          parallelToolCalls: true,
          store: false,
        },
      },
    });

    if (result.toolCalls.length > 0) {
      const invalidCalls = result.toolCalls.filter(
        (call) => call.dynamic || call.invalid,
      );
      if (invalidCalls.length > 0) {
        return {
          type: "error",
          message: invalidCalls
            .map(
              (call) =>
                `${call.toolName}: ${call.error ? errorMessage(call.error) : "invalid tool call"}`,
            )
            .join("; "),
        };
      }

      const message = result.responseMessages.findLast(
        (candidate) => candidate.role === "assistant",
      );
      if (!message) {
        return {
          type: "error",
          message: "model emitted tool calls without an assistant message",
        };
      }

      const parsedMessage = assistantModelMessageSchema.safeParse(message);
      if (!parsedMessage.success) {
        return {
          type: "error",
          message: `assistant message failed validation: ${validationMessage(parsedMessage.error)}`,
        };
      }

      const parsedCalls = ToolCallsSchema.safeParse(result.toolCalls);
      if (!parsedCalls.success) {
        return {
          type: "error",
          message: `tool calls failed validation: ${validationMessage(parsedCalls.error)}`,
        };
      }

      return {
        type: "tool_calls",
        message: parsedMessage.data,
        calls: parsedCalls.data,
      };
    }

    if (result.finishReason === "length") {
      return {
        type: "error",
        message: "model response exceeded its token limit",
      };
    }
    if (result.finishReason === "content-filter") {
      return {type: "error", message: "model response was filtered"};
    }
    return result.text
      ? {type: "text", content: result.text}
      : {type: "error", message: "model returned neither text nor tool calls"};
  });
}

// This fast classification runs directly in the Agent handler. If it fails,
// the Agent conservatively queues the message rather than losing it.
export function* routeMessage(
  message: string,
  recentConversation: string[],
): Operation<MessageRoute> {
  return yield* run(
    ({signal}) =>
      withOpenAI(async (openai): Promise<MessageRoute> => {
        const result = await generateText({
          model: openai.chat(ROUTER_MODEL),
          system: ROUTER_SYSTEM,
          prompt: JSON.stringify({recentConversation, newMessage: message}),
          output: Output.choice({options: [...MESSAGE_ROUTES]}),
          maxOutputTokens: 32,
          maxRetries: 0,
          abortSignal: signal,
          timeout: 5_000,
          providerOptions: {openai: {store: false}},
        });
        return result.output;
      }),
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
      function* ({messages, tools}): Operation<ModelResult> {
        return yield* run(
          ({signal}) => completeAgent(messages, tools, signal),
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
  tools: ToolManifest[],
): Operation<ModelResult> {
  return yield* scope(MODEL_SCOPE)
    .client(ModelGateway)
    .complete(
      {messages, tools},
      Opts.from({limitKey: agentLimitKey(agentId), name: "agent-model"}),
    );
}
