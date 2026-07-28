// Restate admission, retry, and cancellation boundary for agent and guardrail
// model calls. Provider-specific inference remains in model.ts.

import {createHash} from "node:crypto";
import {CancelledError, Opts} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {
  AGENT_MODEL,
  type AgentModelRequest,
  AgentModelRequestSchema,
  completeAgent,
  evaluateGuardrails,
  GUARDRAIL_MODEL,
  type GuardrailDecision,
  GuardrailDecisionSchema,
  type GuardrailEvaluationRequest,
  GuardrailEvaluationRequestSchema,
  type ModelResult,
  ModelResultSchema,
} from "./model.js";

const MODEL_SCOPE = "openai";

// Model calls are service handlers so Restate can apply scope-based concurrency
// control before provider requests start.
export const ModelGateway = restate.service({
  name: "ModelGateway",
  handlers: {
    complete: restate.schemas(
      {input: AgentModelRequestSchema, output: ModelResultSchema},
      function* (request: AgentModelRequest): restate.Operation<ModelResult> {
        return yield* restate.run(
          ({signal}) => completeAgent(request, signal),
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

    evaluateGuardrails: restate.schemas(
      {
        input: GuardrailEvaluationRequestSchema,
        output: GuardrailDecisionSchema,
      },
      function* (
        request: GuardrailEvaluationRequest,
      ): restate.Operation<GuardrailDecision> {
        return yield* restate.run(
          ({signal}) => evaluateGuardrails(request, signal),
          {
            name: "guardrail-model",
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
});

function agentLimitKey(model: string, agentId: string): string {
  const agent = createHash("sha256").update(agentId).digest("hex").slice(0, 24);
  return `${model}/${agent}`;
}

// Agent-step model work goes through the scoped gateway. The `openai` scope is
// the provider-wide budget; the two limit-key levels are model and agent.
export function* callModel(
  request: AgentModelRequest & {agentId: string},
): restate.Operation<ModelResult> {
  const {agentId, ...modelRequest} = request;
  const call = restate
    .scope(MODEL_SCOPE)
    .client(ModelGateway)
    .complete(
      modelRequest,
      Opts.from({
        limitKey: agentLimitKey(AGENT_MODEL, agentId),
        name: "agent-model",
      }),
    );
  const invocation = yield* call.invocation;
  try {
    return yield* call;
  } catch (error) {
    if (
      error instanceof restate.InterruptedError ||
      error instanceof CancelledError
    ) {
      invocation.cancel();
    }
    throw error;
  }
}

export function* callGuardrailModel(
  request: GuardrailEvaluationRequest & {agentId: string},
): restate.Operation<GuardrailDecision> {
  const {agentId, ...evaluationRequest} = request;
  const call = restate
    .scope(MODEL_SCOPE)
    .client(ModelGateway)
    .evaluateGuardrails(
      evaluationRequest,
      Opts.from({
        limitKey: agentLimitKey(GUARDRAIL_MODEL, agentId),
        name: "guardrail-model",
      }),
    );
  const invocation = yield* call.invocation;
  try {
    return yield* call;
  } catch (error) {
    if (
      error instanceof restate.InterruptedError ||
      error instanceof CancelledError
    ) {
      invocation.cancel();
    }
    throw error;
  }
}
