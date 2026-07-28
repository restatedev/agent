// Restate admission, retry, and cancellation boundary for full agent model
// calls. Provider-specific inference remains in model.ts.

import {createHash} from "node:crypto";
import {CancelledError, Opts} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {
  AGENT_MODEL,
  type AgentModelRequest,
  completeAgent,
  type ModelResult,
} from "./model.js";

const MODEL_SCOPE = "openai";

// The main model call is a service so Restate can apply scope-based concurrency
// control before the expensive provider request starts.
export const ModelGateway = restate.service({
  name: "ModelGateway",
  handlers: {
    *complete(request: AgentModelRequest): restate.Operation<ModelResult> {
      return yield* restate.run(({signal}) => completeAgent(request, signal), {
        name: "agent-model",
        retry: {
          maxAttempts: 4,
          initialInterval: 500,
          maxInterval: 5_000,
          exponentiationFactor: 2,
        },
      });
    },
  },
});

function agentLimitKey(agentId: string): string {
  const agent = createHash("sha256").update(agentId).digest("hex").slice(0, 24);
  return `${AGENT_MODEL}/${agent}`;
}

// Only agent steps go through the scoped gateway. The `openai` scope is
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
      Opts.from({limitKey: agentLimitKey(agentId), name: "agent-model"}),
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
