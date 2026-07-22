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

const MESSAGE_ROUTES = ["steer", "interrupt", "queue"] as const;
export type MessageRoute = (typeof MESSAGE_ROUTES)[number];

export const AGENT_MODEL = "gpt-5.6-terra";
const ROUTER_MODEL = "gpt-4o-mini";

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

export async function completeAgent(
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
          // in agent-loop. The model deliberately receives no executors.
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

// This fast classification runs directly in the Agent handler.
export function* routeMessage(message: string): Operation<MessageRoute> {
  return yield* run(
    ({signal}) =>
      withOpenAI(async (openai): Promise<MessageRoute> => {
        const result = await generateText({
          model: openai.chat(ROUTER_MODEL),
          system: ROUTER_SYSTEM,
          prompt: message,
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
