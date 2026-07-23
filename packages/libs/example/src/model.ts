// Everything specific to the model provider lives here: shared model
// contracts, model selection, inference, and the cheap message router.

import {createOpenAI, type OpenAIProvider} from "@ai-sdk/openai";
import {TerminalError} from "@restatedev/restate-sdk";
import {type Operation, run} from "@restatedev/restate-sdk-gen";
import {
  APICallError,
  type AssistantModelMessage,
  generateText,
  jsonSchema,
  type ModelMessage,
  Output,
  streamText,
  type ToolSet,
} from "ai";

export type ToolManifest = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type ModelResult =
  | {type: "text"; content: string}
  | {
      type: "tool_calls";
      message: AssistantModelMessage;
      calls: ToolCall[];
    }
  | {type: "error"; message: string};

export type ModelStreamChunk =
  | {type: "text"; content: string}
  | ({type: "tool_call"} & ToolCall)
  | {type: "error"; message: string};

const MESSAGE_ROUTES = ["steer", "interrupt", "queue"] as const;
export type MessageRoute = (typeof MESSAGE_ROUTES)[number];

export const AGENT_MODEL = "gpt-5.6-terra";
const ROUTER_MODEL = "gpt-4o-mini";

const AGENT_SYSTEM = [
  "You are a concise assistant.",
  "Use the available tools whenever they are needed to fulfill the request.",
  "Group independent tool calls in one response so they can run in parallel.",
  "A pending tool result means the operation is still running across model rounds; do not call it again.",
  "Runtime updates report when pending tools complete, fail, or are cancelled.",
  "When the user asks to stop pending work, call cancelOperation with its operationId and wait for the cancellation result before claiming it stopped.",
  "Call humanApproval by itself, and do not perform any dependent action while its result is pending.",
  "After receiving tool results, answer the user's request directly.",
].join(" ");

const ROUTER_SYSTEM = [
  "Another agent turn is currently running. Classify the new user message.",
  "Use the recent conversation to decide whether the new message belongs to the active request or starts independent work.",
  "Use interrupt only for an explicit request to stop or cancel current work.",
  "Use steer for any context-dependent continuation of the active request, including additions, corrections, refinements, constraints, or questions about its work.",
  "Messages beginning with words such as 'also', 'and', 'actually', 'instead', or 'include' normally steer because they extend or revise the active request.",
  "For example, after a request for European weather, 'also add a few US cities' is steer.",
  "Use queue only when the new request is clearly independent and could be understood without the active request or its result.",
  "When uncertain whether a message is a continuation or independent work, prefer steer.",
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
    rethrowProviderError(error);
  }
}

function rethrowProviderError(error: unknown): never {
  // Restate owns retries. Invalid requests and authentication failures are
  // terminal; throttling and transient provider failures remain retryable.
  if (APICallError.isInstance(error) && !error.isRetryable) {
    throw new TerminalError(`OpenAI rejected the request: ${error.message}`, {
      errorCode: error.statusCode,
    });
  }
  throw error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelTools(tools: ToolManifest[]): ToolSet {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        // Tool manifests are produced from Zod's draft-07 JSON Schema output
        // in agent-loop. The model deliberately receives no executors.
        inputSchema: jsonSchema(
          tool.inputSchema as Parameters<typeof jsonSchema>[0],
        ),
        strict: true,
      },
    ]),
  );
}

export async function completeAgent(
  messages: ModelMessage[],
  tools: ToolManifest[],
  signal: AbortSignal,
): Promise<ModelResult> {
  return withOpenAI(async (openai) => {
    const result = await generateText({
      model: openai.responses(AGENT_MODEL),
      system: AGENT_SYSTEM,
      messages,
      tools: modelTools(tools),
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
        (candidate): candidate is AssistantModelMessage =>
          candidate.role === "assistant",
      );
      if (!message) {
        return {
          type: "error",
          message: "model emitted tool calls without an assistant message",
        };
      }

      return {
        type: "tool_calls",
        message,
        calls: result.toolCalls.map(({toolCallId, toolName, input}) => ({
          toolCallId,
          toolName,
          input,
        })),
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

// Stream only chunks useful to an agent consumer. Tool input deltas and
// provider bookkeeping stay inside the model boundary; tool calls are emitted
// only after the AI SDK has assembled their complete input.
export async function* streamAgent(
  messages: ModelMessage[],
  tools: ToolManifest[],
  signal: AbortSignal,
): AsyncGenerator<ModelStreamChunk> {
  let emitted = false;
  try {
    const result = streamText({
      model: openAI().responses(AGENT_MODEL),
      system: AGENT_SYSTEM,
      messages,
      tools: modelTools(tools),
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

    for await (const part of result.stream) {
      switch (part.type) {
        case "text-delta":
          if (part.text) {
            emitted = true;
            yield {type: "text", content: part.text};
          }
          break;
        case "tool-call":
          emitted = true;
          if (part.dynamic || part.invalid) {
            yield {
              type: "error",
              message: `${part.toolName}: ${part.error ? errorMessage(part.error) : "invalid tool call"}`,
            };
            return;
          }
          yield {
            type: "tool_call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          };
          break;
        case "finish":
          if (part.finishReason === "length") {
            yield {
              type: "error",
              message: "model response exceeded its token limit",
            };
            return;
          }
          if (part.finishReason === "content-filter") {
            yield {type: "error", message: "model response was filtered"};
            return;
          }
          break;
        case "error":
          throw part.error;
        case "abort":
          throw new TerminalError(part.reason ?? "model stream was aborted");
      }
    }

    if (!emitted) {
      yield {type: "error", message: "model returned no text or tool calls"};
    }
  } catch (error) {
    rethrowProviderError(error);
  }
}

// This fast classification runs directly in the Agent handler.
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
