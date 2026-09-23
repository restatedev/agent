import type {
  HandlerDescriptor,
  VirtualObjectDefinition,
} from "@restatedev/restate-sdk-gen";

import type {AgentDefinition, AgentSessionDefinition} from "./services.js";

/** Stable Restate service names needed by lightweight external clients. */
export const AGENT_SERVICE_NAME = "Agent";
export const AGENT_SESSION_SERVICE_NAME = "AgentSession";
export const DEFAULT_ASK =
  "What is the weather in the top 10 European capitals? Also sleep for 4 minutes.";

type IngressHandlers<D> = D extends {
  readonly _handlers: infer H extends Record<string, HandlerDescriptor>;
}
  ? {
      [K in keyof H]: H[K] extends HandlerDescriptor<infer I, infer O>
        ? [undefined] extends [I]
          ? (context: unknown) => Promise<O>
          : (context: unknown, input: I) => Promise<O>
        : never;
    }
  : never;

export type AgentIngressHandlers = IngressHandlers<typeof AgentDefinition>;
export type AgentSessionIngressHandlers = IngressHandlers<
  typeof AgentSessionDefinition
>;
export const AgentIngressDefinition: VirtualObjectDefinition<
  typeof AGENT_SERVICE_NAME,
  AgentIngressHandlers
> = {name: AGENT_SERVICE_NAME};

export const AgentSessionIngressDefinition: VirtualObjectDefinition<
  typeof AGENT_SESSION_SERVICE_NAME,
  AgentSessionIngressHandlers
> = {name: AGENT_SESSION_SERVICE_NAME};
