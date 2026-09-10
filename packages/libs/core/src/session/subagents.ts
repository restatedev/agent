// A pending tool's completion owns the whole child lifetime, including cleanup.
import type {
  AgentProfile,
  AgentTurnOutcome,
  SubagentSpec,
} from "@restate-agents/types";
import {AgentDefinition} from "@restate-agents/types/services";
import {CancelledError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {MAX_SUBAGENT_RESULT} from "../subagent.js";

export function* runSubagent(
  spec: SubagentSpec,
  key: {agentId: string; turnId: string; toolCallId: string},
  profile: AgentProfile,
  availableTools: string[],
): restate.Operation<
  {status: "succeeded"; result: string} | {status: "failed"; error: string}
> {
  const childKey = {parentTurnId: key.turnId, toolCallId: key.toolCallId};
  try {
    // Send + attach: interrupting this waiter must not cancel registration
    // halfway through starting the child. The owner's cancel tombstone closes
    // the gap even when interruption precedes receipt of this invocation ID.
    const registration = yield* restate
      .sendClient(AgentDefinition, key.agentId)
      .startSubagent({
        ...childKey,
        spec,
        profile,
        availableTools,
      });
    const started = yield* registration.attach();
    if (!started.accepted) {
      return {status: "failed", error: started.error};
    }
    const turnId = started.child.turnId;
    if (!turnId) throw new Error("Sub-agent did not start");
    const outcome = yield* restate
      .invocation<AgentTurnOutcome>(turnId)
      .attach();
    // A failed or stopped child is not successful work. Preserve its status
    // and partial result for the parent, without forwarding its tool trajectory.
    return {
      status: "succeeded",
      result: JSON.stringify({
        agentId: started.child.agentId,
        name: started.child.name,
        status: outcome.status,
        ...("response" in outcome
          ? {response: outcome.response?.slice(0, MAX_SUBAGENT_RESULT)}
          : {}),
        ...("error" in outcome ? {error: outcome.error.slice(0, 2_000)} : {}),
        ...("reason" in outcome ? {reason: outcome.reason} : {}),
      }),
    };
  } catch (error) {
    const cancellation = yield* restate
      .sendClient(AgentDefinition, key.agentId)
      .cancelSubagent(childKey);
    // Structured interruption can park on cleanup. External invocation
    // cancellation cannot; the durable send above transfers cleanup ownership.
    if (!(error instanceof CancelledError)) {
      const child = yield* cancellation.attach();
      if (child?.turnId) {
        const [joined] = yield* restate.allSettled([
          restate.invocation(child.turnId).attach(),
        ]);
        if (
          joined.status === "rejected" &&
          !(joined.reason instanceof CancelledError)
        )
          throw joined.reason;
      }
    }
    throw error;
  }
}
