// Restate endpoint for the Agent controller, Turn supervisor, agent-scoped
// Sandbox, scoped model gateway, and durable eval cases. OPENAI_API_KEY is
// required when a model call runs.

import {serve} from "@restatedev/restate-sdk";
import {Agent} from "./agent.js";
import {Evals} from "./eval.js";
import {ModelGateway} from "./model-gateway.js";
import {Sandbox} from "./sandbox.js";
import {Turn} from "./turn.js";

serve({
  services: [Agent, Turn, ModelGateway, Sandbox, Evals],
});
