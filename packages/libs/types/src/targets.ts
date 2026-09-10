import type {
  HandlerDescriptor,
  VirtualObjectDefinition,
} from "@restatedev/restate-sdk-gen";
import type {
  AgentDefinition,
  AgentNotificationsDefinition,
  AgentSchedulerDefinition,
  AgentSessionDefinition,
  UserDefinition,
  UserSessionDefinition,
} from "./services.js";

/** Stable Restate service names needed by lightweight external clients. */
export const AGENT_SERVICE_NAME = "Agent";
export const AGENT_SESSION_SERVICE_NAME = "AgentSession";
export const AGENT_NOTIFICATIONS_SERVICE_NAME = "AgentNotifications";
export const AGENT_SCHEDULER_SERVICE_NAME = "AgentScheduler";
export const UserIngressDefinition: VirtualObjectDefinition<
  "User",
  IngressHandlers<typeof UserDefinition>
> = {name: "User"};
export const UserSessionIngressDefinition: VirtualObjectDefinition<
  "UserSession",
  IngressHandlers<typeof UserSessionDefinition>
> = {name: "UserSession"};

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
export type UserIngressHandlers = IngressHandlers<typeof UserDefinition>;
export type UserSessionIngressHandlers = IngressHandlers<
  typeof UserSessionDefinition
>;
export type AgentSessionIngressHandlers = IngressHandlers<
  typeof AgentSessionDefinition
>;
export type AgentNotificationsIngressHandlers = IngressHandlers<
  typeof AgentNotificationsDefinition
>;
export type AgentSchedulerIngressHandlers = IngressHandlers<
  typeof AgentSchedulerDefinition
>;

export const AgentIngressDefinition: VirtualObjectDefinition<
  typeof AGENT_SERVICE_NAME,
  AgentIngressHandlers
> = {name: AGENT_SERVICE_NAME};

export const AgentSessionIngressDefinition: VirtualObjectDefinition<
  typeof AGENT_SESSION_SERVICE_NAME,
  AgentSessionIngressHandlers
> = {name: AGENT_SESSION_SERVICE_NAME};

export const AgentNotificationsIngressDefinition: VirtualObjectDefinition<
  typeof AGENT_NOTIFICATIONS_SERVICE_NAME,
  AgentNotificationsIngressHandlers
> = {name: AGENT_NOTIFICATIONS_SERVICE_NAME};

export const AgentSchedulerIngressDefinition: VirtualObjectDefinition<
  typeof AGENT_SCHEDULER_SERVICE_NAME,
  AgentSchedulerIngressHandlers
> = {name: AGENT_SCHEDULER_SERVICE_NAME};
