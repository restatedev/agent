// Restate endpoint for the Agent controller, Turn supervisor, and scoped model
// gateway. OPENAI_API_KEY is required when a model call runs.

import {serve} from "@restatedev/restate-sdk";
import {Agent} from "./agent.js";
import {ModelGateway} from "./model.js";
import {Turn} from "./turn.js";

serve({
  services: [Agent, Turn, ModelGateway],
});
