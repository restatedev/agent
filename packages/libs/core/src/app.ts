// Restate endpoint for the Agent controller and Session, agent-scoped
// Sandbox, scoped model gateway, and durable eval cases. OPENAI_API_KEY is
// required when a model call runs; the optional Modal sandbox provider uses
// the standard MODAL_TOKEN_ID and MODAL_TOKEN_SECRET credentials.

import {serve} from "@restatedev/restate-sdk";
import {Agent, AgentSession, Evals, ModelGateway, Sandbox} from "./index.js";

serve({
  services: [Agent, AgentSession, ModelGateway, Sandbox, Evals],
});
