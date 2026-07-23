// Restate admission, retry, and cancellation boundary for full agent model
// calls. Provider-specific inference remains in model.ts.

import {createHash} from "node:crypto";
import {Opts} from "@restatedev/restate-sdk";
import {
  InterruptedError,
  type Operation,
  run,
  scope,
  service,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";
import {
  AGENT_MODEL,
  completeAgent,
  type ModelResult,
  type ToolManifest,
} from "./model.js";

type ModelRequest = {
  messages: ModelMessage[];
  tools: ToolManifest[];
};

const MODEL_SCOPE = "openai";

// The main model call is a service so Restate can apply scope-based concurrency
// control before the expensive provider request starts.
export const ModelGateway = service({
  name: "ModelGateway",
  handlers: {
    *complete({messages, tools}: ModelRequest): Operation<ModelResult> {
      return yield* run(({signal}) => completeAgent(messages, tools, signal), {
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
  options: {
    handlers: {
      complete: {ingressPrivate: true},
    },
  },
});

function agentLimitKey(agentId: string): string {
  const agent = createHash("sha256").update(agentId).digest("hex").slice(0, 24);
  return `${AGENT_MODEL}/${agent}`;
}

// Only the agent loop goes through the scoped gateway. The `openai` scope is
// the provider-wide budget; the two limit-key levels are model and agent.
export function* callModel(
  agentId: string,
  messages: ModelMessage[],
  tools: ToolManifest[],
): Operation<ModelResult> {
  const call = scope(MODEL_SCOPE)
    .client(ModelGateway)
    .complete(
      {messages, tools},
      Opts.from({limitKey: agentLimitKey(agentId), name: "agent-model"}),
    );
  const invocation = yield* call.invocation;
  try {
    return yield* call;
  } catch (error) {
    if (error instanceof InterruptedError) {
      invocation.cancel();
    }
    throw error;
  }
}
