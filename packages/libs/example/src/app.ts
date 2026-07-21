// Entrypoint: a conversational weather agent, wired from three Restate
// constructs.
//
//   - Agent (./agent): the general conversation VirtualObject — a clean thread
//     of one user message per ask and one assistant summary per turn, plus the
//     single `ask` entry point and shared interrupt/steer controls.
//   - Turn (./turn-conversation): the per-turn detailed conversation
//     VirtualObject — the "inside the run" trace (chunks + tool calls/results),
//     kept separate from the general conversation.
//   - TurnService (./turn): the stateless turn loop that runs the closed
//     model->tool->model loop, writing detail to Turn and one summary to Agent.
//
// Set OPENAI_API_KEY in the environment before running.

import {serve} from "@restatedev/restate-sdk";
import {Agent} from "./agent";
import {TurnService} from "./turn";
import {Turn} from "./turn-conversation";

serve({
  services: [Agent, Turn, TurnService],
});
