import type {Message, Tool} from "@restate-agents/core";
import type {Guardrail} from "@restate-agents/types";

import type {TurnSandbox} from "../sandbox/index.js";
import type {TurnHistory} from "./history.js";

/** A human approval granted under a guardrail, reusable within its scope. */
export type GuardrailApproval = {
  guardrailId: string;
  question: string;
  action: unknown;
};

/** Turn-local policy evidence. Steering resets approvals and rejections. */
export type TurnPolicy = {
  guardrails: Guardrail[];
  /** Where the turn's own messages start in the run's model context. */
  evidenceFrom: number;
  /** The turn's messages as of the last model step, which guardrails judge by. */
  evidence: Message[];
  approved: GuardrailApproval[];
  rejected: Set<string>;
};

/** Host capabilities and the stable profile for one turn. Never sent to the model. */
export type TurnContext = {
  agentId: string;
  turnId: string;
  instructions?: string;
  sandbox: TurnSandbox;
  transcript: TurnHistory;
  policy: TurnPolicy;
};

/** A tool that reads the turn's context; the type gives `context` its type. */
export type TurnTool = Tool<TurnContext>;
