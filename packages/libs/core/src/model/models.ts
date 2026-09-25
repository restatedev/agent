// Models used by the session: the agent, its guardrail policy and the
// conversation compactor. Each is a journaled AI SDK call; Restate owns
// retries. The provider reads OPENAI_API_KEY per request, so importing the
// service needs no credentials.

import {createOpenAI} from "@ai-sdk/openai";
import {aiModel} from "@restate-agents/core/provider";

const openai = createOpenAI();

const retry = {
  maxAttempts: 4,
  initialInterval: {milliseconds: 500},
  exponentiationFactor: 2,
  maxInterval: {seconds: 5},
};

export const agentModel = aiModel({
  model: openai.responses("gpt-5.6-luna"),
  providerOptions: {openai: {store: false}},
  retry,
});

export const guardrailModel = aiModel({
  model: openai.responses("gpt-5.6-terra"),
  providerOptions: {openai: {reasoningEffort: "low", store: false}},
  retry,
});

export const compactorModel = aiModel({
  model: openai.chat("gpt-4o-mini"),
  providerOptions: {openai: {store: false}},
  retry,
});
