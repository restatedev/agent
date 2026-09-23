// Restate endpoint for the Agent controller, its Session, and the agent-scoped
// Sandbox. OPENAI_API_KEY is required when a model call runs; the optional
// Modal sandbox provider uses the standard MODAL_TOKEN_ID and
// MODAL_TOKEN_SECRET.

import {serve} from "@restatedev/restate-sdk";

import {Agent, AgentSession, Sandbox} from "./index.js";

serve({services: [Agent, AgentSession, Sandbox]});
