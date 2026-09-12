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
  User,
  UserNotifications,
  UserSession,
} from "./index.js";

serve({
  services: [
    Agent,
    User,
    UserSession,
    AgentNotifications,
    UserNotifications,
    AgentScheduler,
    AgentSession,
    ModelGateway,
    Sandbox,
    Evals,
  ],
});
