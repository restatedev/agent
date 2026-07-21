// Entrypoint for the conversational weather agent.
//
//   - Agent (./agent): the conversation object, owning the user-facing history
//     and active turn. `ask` starts a turn when idle; a message arriving
//     mid-turn is classified by a fast model as queue, steer, or interrupt.
//     Explicit `interrupt`/`steer` handlers exist for clients with real
//     affordances (a stop button, an edit box).
//   - Turn (./turn): the stateless turn loop. Drives the closed
//     model->tool->model loop and appends exactly one structured outcome to the
//     conversation. Restate's invocation observability keeps lower-level detail.
//   - ModelGateway (./model): the scoped admission point for full agent model
//     calls. Cheap mid-turn routing stays directly inside Agent.
//
// Set OPENAI_API_KEY in the environment before running.

import {serve} from "@restatedev/restate-sdk";
import {Agent} from "./agent.js";
import {ModelGateway} from "./model.js";
import {Turn} from "./turn.js";

serve({
  services: [Agent, Turn, ModelGateway],
});
