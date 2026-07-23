// Cheap, latency-sensitive classification for messages received while an
// Agent turn is already active. This intentionally bypasses ModelGateway:
// scope-based admission is reserved for full agent inference.

import {type Operation, run} from "@restatedev/restate-sdk-gen";
import {generateText, Output} from "ai";
import {withOpenAI} from "./model.js";

const MESSAGE_ROUTES = ["steer", "interrupt", "queue"] as const;
export type MessageRoute = (typeof MESSAGE_ROUTES)[number];

const ROUTER_MODEL = "gpt-4o-mini";

const ROUTER_SYSTEM = [
  "Another agent turn is currently running. Classify the new user message.",
  "Use the recent conversation to decide whether the new message belongs to the active request or starts independent work.",
  "Use interrupt only for an explicit request to stop or cancel current work.",
  "Use steer for any context-dependent continuation of the active request, including additions, corrections, refinements, constraints, or questions about its work.",
  "Messages beginning with words such as 'also', 'and', 'actually', 'instead', or 'include' normally steer because they extend or revise the active request.",
  "For example, after a request for European weather, 'also add a few US cities' is steer.",
  "Use queue only when the new request is clearly independent and could be understood without the active request or its result.",
  "When uncertain whether a message is a continuation or independent work, prefer steer.",
].join(" ");

export function* routeMessage(
  message: string,
  recentConversation: string[],
): Operation<MessageRoute> {
  return yield* run(
    ({signal}) =>
      withOpenAI(async (openai): Promise<MessageRoute> => {
        const result = await generateText({
          model: openai.chat(ROUTER_MODEL),
          system: ROUTER_SYSTEM,
          prompt: JSON.stringify({recentConversation, newMessage: message}),
          output: Output.choice({options: [...MESSAGE_ROUTES]}),
          maxOutputTokens: 32,
          maxRetries: 0,
          abortSignal: signal,
          timeout: 5_000,
          providerOptions: {openai: {store: false}},
        });
        return result.output;
      }),
    {
      name: "route-message",
      retry: {maxAttempts: 2, initialInterval: 100, maxInterval: 500},
    },
  );
}
