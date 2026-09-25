// Natural-language guardrails as policy agents. The main agent never sees the
// policy list: an evaluator judges each concrete tool call (including calls a
// program emits) and the final text, and an independent reviewer must
// confirm every restrictive decision. A guardrail that requires approval asks
// a human and, once approved, drops out; the rest are checked again until all
// allow, one denies, or a human rejects.

import {
  agent,
  type GuardrailResult,
  type ModelRequest,
  type OutputCandidate,
  type OutputDecision,
  type RunContext,
  type ToolCall,
  type ToolContext,
} from "@restate-agents/core";
import type {Guardrail} from "@restate-agents/types";
import {TerminalError} from "@restatedev/restate-sdk";
import type * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";

import {
  GUARDRAIL_REVIEW_SYSTEM,
  GUARDRAIL_SYSTEM,
  guardrailModel,
} from "../model/index.js";
import {askHuman} from "./tools/approval.js";
import type {TurnContext, TurnPolicy} from "./turn-context.js";

const evaluator = agent({
  model: guardrailModel,
  instructions: GUARDRAIL_SYSTEM,
  output: z.object({
    decision: z.enum(["allow", "deny", "require_approval"]),
    guardrailId: z
      .string()
      .nullable()
      .describe(
        "The matching guardrail id for deny or require_approval, otherwise null.",
      ),
    reason: z
      .string()
      .min(1)
      .describe("A concise explanation of the policy decision."),
    approvalQuestion: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "The specific question to ask a human for require_approval, otherwise null.",
      ),
  }),
  maxSteps: 2,
  maxOutputTokens: 500,
  finalize: false,
});

const reviewer = agent({
  model: guardrailModel,
  instructions: GUARDRAIL_REVIEW_SYSTEM,
  output: z.object({
    confirmed: z
      .boolean()
      .describe(
        "True only when the candidate decision is grounded in the exact proposed action and correctly applies the selected guardrail.",
      ),
    reason: z.string().min(1),
  }),
  maxSteps: 2,
  maxOutputTokens: 500,
  finalize: false,
});

type Decision =
  | {decision: "allow"}
  | {decision: "deny"; guardrail: Guardrail; reason: string}
  | {
      decision: "require_approval";
      guardrail: Guardrail;
      reason: string;
      question: string;
    };

/** Evaluates one proposed action; fails closed when a policy run does not complete. */
function* evaluate(
  {instructions, policy}: TurnContext,
  guardrails: Guardrail[],
  action: unknown,
  name: string,
): restate.Operation<Decision> {
  const evidence = {
    persistentInstructions: instructions ?? null,
    guardrails,
    approvedActions: policy.approved,
    rejectedGuardrailIds: [...policy.rejected],
    conversation: policy.evidence,
    proposedAction: action,
  };
  const evaluated = yield* evaluator.run(JSON.stringify(evidence), {
    name: `${name}-evaluate`,
  });
  if (evaluated.status !== "completed")
    throw new TerminalError(`Guardrail evaluation ${evaluated.status}`);
  const {decision, guardrailId, reason, approvalQuestion} = evaluated.output;
  if (decision === "allow") return {decision};
  const guardrail = guardrails.find(({id}) => id === guardrailId);
  if (!guardrail)
    throw new TerminalError(
      `Guardrail evaluator returned an unknown id: ${guardrailId}`,
    );
  const candidate: Decision =
    decision === "deny" || policy.rejected.has(guardrail.id)
      ? {decision: "deny", guardrail, reason}
      : {
          decision,
          guardrail,
          reason,
          question: approvalQuestion ?? `Allow this action? ${reason}`,
        };

  const reviewed = yield* reviewer.run(
    JSON.stringify({
      ...evidence,
      guardrail,
      candidateDecision: {decision: candidate.decision, reason},
    }),
    {name: `${name}-review`},
  );
  if (reviewed.status !== "completed")
    throw new TerminalError(`Guardrail review ${reviewed.status}`);
  return reviewed.output.confirmed ? candidate : {decision: "allow"};
}

type Verdict =
  | {allowed: true}
  | {allowed: false; guardrailId: string; reason: string};

/** Checks an action against every guardrail, asking a human where one requires it. */
function* check(
  context: TurnContext,
  action: unknown,
  name: string,
): restate.Operation<Verdict> {
  const {policy} = context;
  let remaining = policy.guardrails;
  for (let round = 1; remaining.length > 0; round++) {
    const decision = yield* evaluate(
      context,
      remaining,
      action,
      `${name}-${round}`,
    );
    if (decision.decision === "allow") return {allowed: true};
    const {guardrail} = decision;
    if (decision.decision === "deny")
      return {
        allowed: false,
        guardrailId: guardrail.id,
        reason: decision.reason,
      };
    const resolution = yield* askHuman(context, {
      approvalId: `${name}-${round}`,
      question: decision.question,
      guardrailId: guardrail.id,
    });
    if (!resolution)
      return {
        allowed: false,
        guardrailId: guardrail.id,
        reason: "human approval could not be registered",
      };
    if (resolution.decision === "rejected") {
      policy.rejected.add(guardrail.id);
      const reason = resolution.reason
        ? `Human rejected the request: ${resolution.reason}`
        : "Human rejected the request";
      return {allowed: false, guardrailId: guardrail.id, reason};
    }
    policy.approved.push({
      guardrailId: guardrail.id,
      question: decision.question,
      action,
    });
    remaining = remaining.filter(({id}) => id !== guardrail.id);
  }
  return {allowed: true};
}

/** Records the turn's messages before each model step; guardrails judge by them. */
export function* recordEvidence(
  request: ModelRequest,
  {context}: RunContext<TurnContext>,
): restate.Operation<void> {
  context.policy.evidence = request.messages.slice(context.policy.evidenceFrom);
}

/**
 * Gates one concrete tool call before it runs. A program wrapper is not
 * gated: each call it emits passes through here with its own name and input.
 */
export function* guardToolCall(
  call: ToolCall,
  {context}: ToolContext<TurnContext>,
): restate.Operation<GuardrailResult> {
  if (context.policy.guardrails.length === 0 || call.name === "executeProgram")
    return;
  const action = {type: "tool_call", name: call.name, input: call.input};
  const verdict = yield* check(context, action, `policy-${call.id}`);
  if (verdict.allowed) return;
  return `Blocked by guardrail ${JSON.stringify(verdict.guardrailId)}: ${verdict.reason}. Do not repeat the blocked action. Choose a clearly compliant alternative, or return a concise tool-free refusal.`;
}

/** Gates the final text before it is published; a human may approve it. */
export function* guardOutput(
  candidate: OutputCandidate,
  context: TurnContext,
): restate.Operation<void | OutputDecision> {
  if (context.policy.guardrails.length === 0 || !candidate.output?.trim())
    return;
  const action = {type: "text", content: candidate.output};
  const verdict = yield* check(context, action, "policy-output");
  if (verdict.allowed) return;
  if (candidate.status === "completed")
    return {
      output:
        "I can’t complete that request because it conflicts with a configured policy.",
    };
  return {
    output:
      "The turn stopped, but its final summary was withheld by a guardrail.",
  };
}

/** Steering changes the request, so earlier decisions no longer apply to it. */
export function resetPolicy(policy: TurnPolicy): void {
  policy.approved = [];
  policy.rejected.clear();
}
