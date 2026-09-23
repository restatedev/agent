// Restate endpoint for the Agent controller, Session, Notifications,
// Scheduler, agent-scoped Sandbox, and scoped model
// gateway. OPENAI_API_KEY is required when a model call runs; the optional Modal
// sandbox provider uses the standard MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.

import {serve} from "@restatedev/restate-sdk";

import {
  Agent,
  AgentNotifications,
  AgentScheduler,
  AgentSession,
  ModelGateway,
  Sandbox,
} from "./index.js";

serve({
  services: [
    Agent,
    AgentScheduler,
    AgentNotifications,
    AgentSession,
    ModelGateway,
    Sandbox,
  ],
});
