// Durable model calls made inside the turn. Each provider attempt is a
// journaled run: replay reuses the recorded result, and interrupting the turn
// aborts the in-flight request through the run's signal. The provider calls
// themselves are in provider.ts.

import * as restate from "@restatedev/restate-sdk-gen";

import {
  type AgentModelRequest,
  type GuardrailDecision,
  type GuardrailEvaluationRequest,
  MAX_AGENT_OUTPUT_TOKENS,
  modelProvider,
  type ModelResult,
} from "./provider.js";

// Restate owns transport retries; a truncated generation gets at most one
// separately journaled recovery.
const MODEL_RETRY = {
  maxAttempts: 4,
  initialInterval: 500,
  maxInterval: 5_000,
  exponentiationFactor: 2,
};

/** Asks the agent model for its next action, recovering once from truncation. */
export function* callModel(
  request: AgentModelRequest,
): restate.Operation<ModelResult> {
  const result = yield* restate.run(
    ({signal}) => modelProvider.completeAgent(request, signal),
    {name: "agent-model", retry: MODEL_RETRY},
  );
  if (
    result.type !== "error" ||
    result.code !== "output_limit" ||
    !result.maxOutputTokens ||
    result.maxOutputTokens >= MAX_AGENT_OUTPUT_TOKENS
  )
    return result;
  // Derive the recovery budget from the journaled result, not current env.
  const budget = Math.min(result.maxOutputTokens * 2, MAX_AGENT_OUTPUT_TOKENS);
  return yield* restate.run(
    ({signal}) =>
      modelProvider.completeAgent(
        {
          ...request,
          messages: [
            ...request.messages,
            {
              role: "user",
              content:
                "[Runtime output recovery] The previous generation exhausted its output budget and was discarded; none of its tool calls executed. Retry with a concise answer or a smaller tool/program batch. Use the existing tool results; do not repeat completed work.",
            },
          ],
        },
        signal,
        budget,
      ),
    {name: "agent-model-output-recovery", retry: MODEL_RETRY},
  );
}

/** Evaluates guardrails; a non-allow decision is confirmed by a second review. */
export function* callGuardrailModel(
  request: GuardrailEvaluationRequest,
): restate.Operation<GuardrailDecision> {
  const decision = yield* restate.run(
    ({signal}) => modelProvider.evaluateGuardrails(request, signal),
    {name: "guardrail-model", retry: MODEL_RETRY},
  );
  if (decision.decision === "allow") return decision;
  const confirmed = yield* restate.run(
    ({signal}) =>
      modelProvider.confirmGuardrailDecision(request, decision, signal),
    {name: "guardrail-review", retry: MODEL_RETRY},
  );
  return confirmed ? decision : {decision: "allow"};
}
