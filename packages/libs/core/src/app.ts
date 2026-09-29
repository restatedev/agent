// Restate endpoint for the Agent controller and its Session. A model call
// needs the API key of its provider (OPENAI_API_KEY, ANTHROPIC_API_KEY or
// GOOGLE_GENERATIVE_AI_API_KEY; see agent-config.ts); the optional Modal
// sandbox provider uses the standard MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.

import {serve} from "@restatedev/restate-sdk";

import {Agent, AgentSession} from "./index.js";

serve({services: [Agent, AgentSession]});
