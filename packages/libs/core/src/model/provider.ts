// Model inference through the AI SDK, and the contracts the turn consumes.

import {anthropic} from "@ai-sdk/anthropic";
import {createDeepSeek} from "@ai-sdk/deepseek";
import {google} from "@ai-sdk/google";
import {openai} from "@ai-sdk/openai";
import {createOpenAICompatible} from "@ai-sdk/openai-compatible";
import {xai} from "@ai-sdk/xai";
import type {Guardrail} from "@restate-agents/types";
import {TerminalError} from "@restatedev/restate-sdk";
import {
  APICallError,
  type AssistantModelMessage,
  generateText,
  jsonSchema,
  type LanguageModel,
  LoadAPIKeyError,
  type ModelMessage,
  Output,
  type ToolSet,
  UnsupportedFunctionalityError,
} from "ai";
import {z} from "zod";

import {agentConfig} from "../agent-config.js";
import {errorMessage} from "../errors.js";
import {
  COMPACTOR_SYSTEM,
  GUARDRAIL_REVIEW_SYSTEM,
  GUARDRAIL_SYSTEM,
  TURN_COMPACTOR_SYSTEM,
} from "./prompts.js";

// The message shapes of a model call, named here so that the rest of the
// runtime depends on this module and not on the inference library.
export type {JSONValue, ModelMessage, ToolModelMessage} from "ai";

/** Provider-neutral model description of one executable agent tool. */
export type ToolManifest = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  strict?: boolean;
  /** Guidance for the system prompt while this tool is offered. */
  instructions?: string;
};

/** Complete input for one agent-model inference step. */
export type AgentModelRequest = {
  instructions?: string;
  messages: ModelMessage[];
  tools: ToolManifest[];
};

/** One validated tool call emitted by the model. */
export type ToolCall = {toolCallId: string; toolName: string; input: unknown};

/**
 * Normalized agent-model result consumed by the session state machine.
 * `inputTokens` is the provider's count of the request's input, when reported.
 */
export type ModelResult = (
  | {type: "text"; content: string}
  | {
      type: "tool_calls";
      message: AssistantModelMessage;
      calls: ToolCall[];
      activity?: string;
    }
  | {
      type: "error";
      message: string;
      code?: "output_limit";
      maxOutputTokens?: number;
    }
) & {inputTokens?: number};

/** Text or tool action evaluated by runtime guardrails before commitment. */
export type ProposedAction =
  | {type: "text"; content: string}
  | {type: "tool_calls"; calls: ToolCall[]; activity?: string};

/** Human authorization retained for scope checks later in the same Turn. */
export type GuardrailApproval = {
  guardrailId: string;
  question: string;
  action: ProposedAction;
};

/** Full evidence supplied to one guardrail evaluation. */
export type GuardrailEvaluationRequest = {
  instructions?: string;
  guardrails: Guardrail[];
  approvedActions: GuardrailApproval[];
  rejectedGuardrailIds: string[];
  messages: ModelMessage[];
  action: ProposedAction;
};

/** Runtime policy outcome for one proposed model action. */
export type GuardrailDecision =
  | {decision: "allow"}
  | {decision: "deny"; guardrailId: string; reason: string}
  | {
      decision: "require_approval";
      guardrailId: string;
      reason: string;
      question: string;
    };

export const MAX_AGENT_OUTPUT_TOKENS = 64_000;
/** Evaluated inside a journaled inference, never in replayed Turn control flow. */
function agentOutputBudget(): number {
  const raw = process.env.AGENT_MODEL_MAX_OUTPUT_TOKENS ?? "32000";
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < 1024 ||
    value > MAX_AGENT_OUTPUT_TOKENS
  )
    throw new TerminalError(
      "AGENT_MODEL_MAX_OUTPUT_TOKENS must be an integer between 1024 and 64000",
    );
  return value;
}

const GuardrailEvaluationSchema = z.object({
  decision: z.enum(["allow", "deny", "require_approval"]),
  guardrailId: z
    .string()
    .nullable()
    .describe(
      "The matching guardrail id for deny or require_approval, otherwise null.",
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .describe("A concise explanation of the policy decision."),
  approvalQuestion: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe(
      "The specific question to ask a human for require_approval, otherwise null.",
    ),
});

const GuardrailReviewSchema = z.object({
  confirmed: z
    .boolean()
    .describe(
      "True only when the candidate decision is grounded in the exact proposed action and correctly applies the selected guardrail.",
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .describe(
      "A concise explanation of why the candidate is confirmed or rejected.",
    ),
});

/**
 * The providers a model ID in agent-config.ts may name, as "provider:model".
 * Each provider reads its API key from the environment when a call is made
 * (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY,
 * XAI_API_KEY, DEEPSEEK_API_KEY), so only the providers the configured
 * models use need a key.
 */
const PROVIDERS: Record<string, (model: string) => LanguageModel> = {
  openai,
  anthropic,
  google,
  xai,
  // Built-in tools use strict schemas, which DeepSeek accepts only on its
  // beta endpoint.
  deepseek: createDeepSeek({baseURL: "https://api.deepseek.com/beta"}),
  "openai-compatible": openAICompatible,
};

/**
 * Any server that speaks the OpenAI chat completions API: Ollama, vLLM and
 * LM Studio for open models on your own hardware, or a hosted router such as
 * OpenRouter or Together. OPENAI_COMPATIBLE_BASE_URL names the server;
 * OPENAI_COMPATIBLE_API_KEY is optional, since local servers need none.
 *
 * The guardrails ask for structured output with a JSON schema, which these
 * servers support; without it the model would see no schema to follow.
 */
function openAICompatible(model: string): LanguageModel {
  const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
  if (!baseURL) {
    throw new TerminalError(
      `model "openai-compatible:${model}" needs OPENAI_COMPATIBLE_BASE_URL`,
    );
  }
  const provider = createOpenAICompatible({
    name: "openai-compatible",
    baseURL,
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
    supportsStructuredOutputs: true,
  });
  return provider(model);
}

/** Resolves a "provider:model" ID from agent-config.ts to its model. */
function languageModel(id: string) {
  const separator = id.indexOf(":");
  const provider = id.slice(0, separator);
  const model = id.slice(separator + 1);
  if (separator < 1 || !model || !Object.hasOwn(PROVIDERS, provider)) {
    const known = Object.keys(PROVIDERS).join(", ");
    throw new TerminalError(
      `model "${id}" must be "provider:model", where the provider is one of: ${known}`,
    );
  }
  return PROVIDERS[provider](model);
}

/** Runs one provider call and classifies the failures a retry cannot fix. */
async function withModel<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    // Restate owns retries. A missing API key, a feature the provider does not
    // support, invalid requests and authentication failures are terminal;
    // throttling and transient provider failures remain retryable.
    if (
      LoadAPIKeyError.isInstance(error) ||
      UnsupportedFunctionalityError.isInstance(error)
    ) {
      throw new TerminalError(error.message);
    }
    if (APICallError.isInstance(error) && !error.isRetryable) {
      throw new TerminalError(
        `The model provider rejected the request: ${error.message}`,
        {errorCode: error.statusCode},
      );
    }
    throw error;
  }
}

/**
 * Settings every call shares. Retries are left to Restate. The reasoning
 * level is provider-neutral: each provider maps it to its own setting
 * (OpenAI's reasoning effort, Anthropic's and Google's thinking).
 */
function callOptions(model: string, signal: AbortSignal, timeout: number) {
  return {
    model: languageModel(model),
    maxRetries: 0,
    abortSignal: signal,
    timeout,
    reasoning: "low" as const,
  };
}

// Options for providers that the configured model does not use are ignored.
// OpenAI would otherwise store every response on its side.
const PROVIDER_OPTIONS = {openai: {store: false}} as const;

/** The evidence both guardrail passes judge: policy, history and the action. */
function guardrailEvidence(request: GuardrailEvaluationRequest) {
  return {
    persistentInstructions: request.instructions ?? null,
    approvedActions: request.approvedActions,
    rejectedGuardrailIds: request.rejectedGuardrailIds,
    conversation: request.messages,
    proposedAction: request.action,
  };
}

// The Responses API counts reasoning tokens against max_output_tokens. The
// decision object itself is a few hundred tokens, but a 500-token budget left
// a reasoning model too little room: the response came back incomplete, the
// structured output failed to parse (NoObjectGeneratedError), and after the
// run's retries the whole turn failed. This leaves ample room for low-effort
// reasoning while still bounding a runaway evaluation.
const GUARDRAIL_MAX_OUTPUT_TOKENS = 4_000;

/** Evaluates a proposed model action against configured natural-language policy. */
export async function evaluateGuardrails(
  request: GuardrailEvaluationRequest,
  signal: AbortSignal,
): Promise<GuardrailDecision> {
  return withModel(async () => {
    const result = await generateText({
      system: GUARDRAIL_SYSTEM,
      prompt: JSON.stringify({
        ...guardrailEvidence(request),
        guardrails: request.guardrails,
      }),
      output: Output.object({schema: GuardrailEvaluationSchema}),
      maxOutputTokens: GUARDRAIL_MAX_OUTPUT_TOKENS,
      ...callOptions(agentConfig.models.guardrail, signal, 30_000),
      providerOptions: PROVIDER_OPTIONS,
    });
    const evaluation = result.output;
    if (evaluation.decision === "allow") {
      return {decision: "allow"};
    }

    const guardrail = request.guardrails.find(
      ({id}) => id === evaluation.guardrailId,
    );
    if (!guardrail) {
      throw new Error(
        `guardrail evaluator returned an unknown id: ${evaluation.guardrailId}`,
      );
    }
    if (evaluation.decision === "deny") {
      return {
        decision: "deny",
        guardrailId: guardrail.id,
        reason: evaluation.reason,
      };
    }
    if (request.rejectedGuardrailIds.includes(guardrail.id)) {
      return {
        decision: "deny",
        guardrailId: guardrail.id,
        reason: `Human approval for this policy was already rejected. ${evaluation.reason}`,
      };
    }
    if (!evaluation.approvalQuestion) {
      throw new Error(
        `guardrail evaluator omitted the approval question for ${guardrail.id}`,
      );
    }
    return {
      decision: "require_approval",
      guardrailId: guardrail.id,
      reason: evaluation.reason,
      question: evaluation.approvalQuestion,
    };
  });
}

/** Independently confirms a restrictive guardrail decision before enforcement. */
export async function confirmGuardrailDecision(
  request: GuardrailEvaluationRequest,
  candidate: Exclude<GuardrailDecision, {decision: "allow"}>,
  signal: AbortSignal,
): Promise<boolean> {
  const guardrail = request.guardrails.find(
    ({id}) => id === candidate.guardrailId,
  );
  if (!guardrail) {
    return false;
  }

  return withModel(async () => {
    const result = await generateText({
      system: GUARDRAIL_REVIEW_SYSTEM,
      prompt: JSON.stringify({
        ...guardrailEvidence(request),
        guardrail,
        candidateDecision: candidate,
      }),
      output: Output.object({schema: GuardrailReviewSchema}),
      maxOutputTokens: GUARDRAIL_MAX_OUTPUT_TOKENS,
      ...callOptions(agentConfig.models.guardrail, signal, 30_000),
      providerOptions: PROVIDER_OPTIONS,
    });
    return result.output.confirmed;
  });
}

/**
 * The base instructions, then the guidance of each tool offered in this step,
 * then the user's persistent instructions.
 */
export function agentSystemPrompt(request: AgentModelRequest): string {
  const toolInstructions: string[] = [];
  for (const tool of request.tools) {
    if (tool.instructions) toolInstructions.push(tool.instructions);
  }
  const prompt = [agentConfig.baseInstructions, ...toolInstructions].join(" ");
  if (!request.instructions) return prompt;
  return [
    prompt,
    "",
    "[Persistent user instructions]",
    "These instructions apply across turns.",
    request.instructions,
  ].join("\n");
}

/** Performs one provider inference and normalizes text, tool, and error output. */
export async function completeAgent(
  request: AgentModelRequest,
  signal: AbortSignal,
  maxOutputTokens = agentOutputBudget(),
): Promise<ModelResult> {
  return withModel(async () => {
    const {messages, tools} = request;
    const toolOptions =
      tools.length > 0
        ? {
            tools: Object.fromEntries(
              tools.map((tool) => [
                tool.name,
                {
                  description: tool.description,
                  // Manifests contain draft-07 JSON Schema and deliberately
                  // carry no executors across the model boundary.
                  inputSchema: jsonSchema(
                    tool.inputSchema as Parameters<typeof jsonSchema>[0],
                  ),
                  strict: tool.strict ?? true,
                },
              ]),
            ) as ToolSet,
            toolChoice: "auto" as const,
          }
        : {};
    const result = await generateText({
      system: agentSystemPrompt(request),
      messages,
      ...toolOptions,
      maxOutputTokens,
      ...callOptions(agentConfig.models.agent, signal, 120_000),
      providerOptions: {openai: {store: false, parallelToolCalls: true}},
    });

    return {
      ...modelResult(result, maxOutputTokens),
      inputTokens: result.usage.inputTokens,
    };
  });
}

/** What the turn needs from one generation: its text, tool calls or error. */
function modelResult(
  result: Awaited<ReturnType<typeof generateText>>,
  maxOutputTokens: number,
): ModelResult {
  // Reject the WHOLE truncated generation before inspecting tool calls. Even
  // a valid-looking call may belong to an incomplete batch/program.
  if (result.finishReason === "length") {
    return {
      type: "error",
      code: "output_limit",
      maxOutputTokens,
      message: `Model generation exceeded its ${maxOutputTokens}-token output budget. No partial response or tool calls were used.`,
    };
  }
  if (result.finishReason === "content-filter") {
    return {type: "error", message: "model response was filtered"};
  }

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
      ...(result.text.trim() ? {activity: result.text.trim()} : {}),
    };
  }

  return result.text.trim()
    ? {type: "text", content: result.text}
    : {type: "error", message: "model returned neither text nor tool calls"};
}

// Reasoning tokens count against max_output_tokens here too (see
// GUARDRAIL_MAX_OUTPUT_TOKENS). The summary itself stays around a thousand
// tokens; the rest is room for low-effort reasoning.
const COMPACTOR_MAX_OUTPUT_TOKENS = 4_000;

/**
 * Folds older conversation entries into the previous summary. The input is
 * already the compactor's view of the entries; see model/compactor.ts.
 */
export async function summarizeConversation(
  input: {previousSummary: string | null; conversation: unknown[]},
  signal: AbortSignal,
): Promise<string> {
  return withModel(async () => {
    const result = await generateText({
      system: COMPACTOR_SYSTEM,
      prompt: JSON.stringify(input),
      maxOutputTokens: COMPACTOR_MAX_OUTPUT_TOKENS,
      ...callOptions(agentConfig.models.compactor, signal, 30_000),
      providerOptions: PROVIDER_OPTIONS,
    });
    const summary = result.text.trim();
    if (!summary) {
      throw new Error("conversation compactor returned an empty summary");
    }
    return summary;
  });
}

// The note replaces a large part of a working context, so it may be longer
// than a conversation summary; reasoning shares the budget.
const TURN_COMPACTOR_MAX_OUTPUT_TOKENS = 12_000;

/**
 * Writes the handoff note that replaces the older part of a turn's working
 * context. The input is already the compactor's view of those messages; see
 * model/compactor.ts.
 */
export async function summarizeTurn(
  input: {request: string | null; messages: unknown[]},
  signal: AbortSignal,
): Promise<string> {
  return withModel(async () => {
    const result = await generateText({
      system: TURN_COMPACTOR_SYSTEM,
      prompt: JSON.stringify(input),
      maxOutputTokens: TURN_COMPACTOR_MAX_OUTPUT_TOKENS,
      ...callOptions(agentConfig.models.compactor, signal, 120_000),
      providerOptions: PROVIDER_OPTIONS,
    });
    const note = result.text.trim();
    if (!note) {
      throw new Error("turn compactor returned an empty note");
    }
    return note;
  });
}

/** The provider calls made by the turn, grouped so tests can replace them. */
export const modelProvider = {
  completeAgent,
  evaluateGuardrails,
  confirmGuardrailDecision,
  summarizeConversation,
  summarizeTurn,
};
