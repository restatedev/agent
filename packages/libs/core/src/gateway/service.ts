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
  confirmGuardrailDecision,
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

// One durable run per handler invocation; Restate owns the retry policy and
// the AI SDK's internal retries stay disabled.
const MODEL_RETRY = {
  maxAttempts: 4,
  initialInterval: 500,
  maxInterval: 5_000,
  exponentiationFactor: 2,
};

/** Model-call service boundary governed by Restate scope concurrency controls. */
export const ModelGateway = restate.service({
  name: "ModelGateway",
  handlers: {
    complete: restate.schemas(
      {input: AgentModelRequestSchema, output: ModelResultSchema},
      function* (request: AgentModelRequest): restate.Operation<ModelResult> {
        return yield* restate.run(
          ({signal}) => completeAgent(request, signal),
          {name: "agent-model", retry: MODEL_RETRY},
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
        const decision = yield* restate.run(
          ({signal}) => evaluateGuardrails(request, signal),
          {name: "guardrail-model", retry: MODEL_RETRY},
        );
        if (decision.decision === "allow") {
          return decision;
        }

        const confirmed = yield* restate.run(
          ({signal}) => confirmGuardrailDecision(request, decision, signal),
          {name: "guardrail-review", retry: MODEL_RETRY},
        );
        return confirmed ? decision : {decision: "allow"};
      },
    ),
  },
});

/** Calls the agent model through provider-, model-, and Agent-scoped admission. */
export function* callModel(
  request: AgentModelRequest & {agentId: string},
): restate.Operation<ModelResult> {
  const {agentId, ...modelRequest} = request;
  return yield* awaitCancellable(
    restate
      .scope(MODEL_SCOPE)
      .client(ModelGateway)
      .complete(
        modelRequest,
        Opts.from({
          limitKey: agentLimitKey(AGENT_MODEL, agentId),
          name: "agent-model",
        }),
      ),
  );
}

/** Calls policy evaluation through the same cancellable admission boundary. */
export function* callGuardrailModel(
  request: GuardrailEvaluationRequest & {agentId: string},
): restate.Operation<GuardrailDecision> {
  const {agentId, ...evaluationRequest} = request;
  return yield* awaitCancellable(
    restate
      .scope(MODEL_SCOPE)
      .client(ModelGateway)
      .evaluateGuardrails(
        evaluationRequest,
        Opts.from({
          limitKey: agentLimitKey(GUARDRAIL_MODEL, agentId),
          name: "guardrail-model",
        }),
      ),
  );
}

function agentLimitKey(model: string, agentId: string): string {
  const agent = createHash("sha256").update(agentId).digest("hex").slice(0, 24);
  return `${model}/${agent}`;
}

// Await one scoped gateway call. The caller must also propagate interruption:
// cancelling the child invocation releases its admission slot immediately
// instead of leaving an abandoned request to run to completion.
function* awaitCancellable<T>(
  call: restate.ClientFuture<T>,
): restate.Operation<T> {
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
