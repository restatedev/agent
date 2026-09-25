// Runs one model tool call through a real agent-SDK run, with a scripted
// model: validation, guardrails, programs and error mapping are the SDK's.
import {agent} from "@restate-agents/core";

import {builtins} from "../src/session/tools.ts";

/** A turn context for tools; tests override what a tool reads. */
export function turnContext(overrides = {}) {
  return {
    agentId: "parent",
    turnId: "turn",
    sandbox: {},
    transcript: {*append() {}},
    policy: {
      guardrails: [],
      evidenceFrom: 0,
      evidence: [],
      approved: [],
      rejected: new Set(),
    },
    ...overrides,
  };
}

/**
 * Makes `call` ({id, name, input}) as the model's first step and returns the
 * tool's result: {status: "success", output} or {status: "error", message}.
 */
export function* runToolCall(
  call,
  {context = turnContext(), tools = builtins, beforeTool} = {},
) {
  let step = 0;
  const probe = agent({
    tools,
    ...(beforeTool ? {beforeTool} : {}),
    *model() {
      if (step++ === 0) return {type: "tool_calls", calls: [call]};
      return {type: "final", text: "done"};
    },
  });
  const result = yield* probe.run("go", {context});
  return result.messages.find((m) => m.role === "tool" && m.callId === call.id)
    .result;
}
