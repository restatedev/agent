import type {GenericCall} from "@restatedev/restate-sdk";
import type {Future, Operation} from "@restatedev/restate-sdk-gen";

export type Hook = () => Operation<void>;

// If a step returns true, the turn breaks, otherwise continues
export type Step = (ctx: StepContext) => Operation<boolean>;

export type LLMChunk =
  | {type: "text"; content: string}
  | {type: "tool_call"; name: string; args: Record<string, string>};

export interface StepContext {
  // Run a closure, recording its value
  run<T>(closure: (abortSignal: AbortSignal) => Promise<T>): Future<T>;

  // Call another agent
  call<REQ, RES>(c: GenericCall<REQ, RES>): Future<RES>;

  // Prompt the LLM
  prompt(prompt: string): Operation<{next(): Future<LLMChunk | {eos: true}>}>;
}

export interface Agent {
  name: string;

  preTurnHooks?: Hook[];
  postTurnHooks?: Hook[];

  preStepHook?: Hook[];
  step: Step;
  postStepHooks?: Hook[];
}
