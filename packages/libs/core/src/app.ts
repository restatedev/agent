// Restate endpoint for the Agent controller, Session, Notifications,
// Scheduler, agent-scoped Sandbox, scoped model gateway, and durable eval
// cases. OPENAI_API_KEY is required when a model call runs; the optional Modal
// sandbox provider uses the standard MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.

import {serve} from "@restatedev/restate-sdk";
import {
  Agent,
  AgentNotifications,
  AgentScheduler,
  AgentSession,
  Evals,
  ModelGateway,
  Sandbox,
} from "./index.js";

serve({
  services: [
    Agent,
    AgentNotifications,
    AgentScheduler,
    AgentSession,
    ModelGateway,
    Sandbox,
    Evals,
  ],
});
