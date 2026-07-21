// Entrypoint for the conversational weather agent.
//
//   - Agent (./agent): the conversation object, owning the user-facing history
//     and active turn. `ask` starts a turn when idle; a message arriving
//     mid-turn is queued, or — by a naive keyword check in this demo — steers
//     or interrupts the running turn. Explicit `interrupt`/`steer` handlers
//     exist for clients with real affordances (a stop button, an edit box).
//   - Turn (./turn): the stateless turn loop. Drives the closed
//     model->tool->model loop and appends exactly one structured outcome to the
//     conversation. Restate's invocation observability keeps lower-level detail.
//   - Weather (./weather): a mock tool implemented as its own Restate service.
//
// Set OPENAI_API_KEY in the environment before running.

import {serve} from "@restatedev/restate-sdk";
import {Agent} from "./agent";
import {Turn} from "./turn";
import {Weather} from "./weather";

serve({
  services: [Agent, Turn, Weather],
});
