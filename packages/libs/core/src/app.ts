// Restate endpoint for the Agent controller and its Session. OPENAI_API_KEY is
// required when a model call runs; the optional Modal sandbox provider uses
// the standard MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.

import {serve} from "@restatedev/restate-sdk";

import {Agent, AgentSession} from "./index.js";

serve({services: [Agent, AgentSession]});
