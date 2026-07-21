// Entrypoint: a conversational weather agent, wired from two Restate constructs.
//
//   - Agent (./agent): a conversation-keyed VirtualObject that owns the durable
//     history and the active turn's invocation id; the single `ask` entry point
//     plus shared interrupt/steer controls.
//   - TurnService (./turn): a stateless Service whose `doTurn` handler owns the
//     turn loop (LLM streaming, tools, steps, interrupt/steering), reporting
//     concise messages back to the Agent via one-way sends.
//
// Set OPENAI_API_KEY in the environment before running.

import {serve} from "@restatedev/restate-sdk";
import {Agent} from "./agent";
import {TurnService} from "./turn";

serve({
  services: [TurnService, Agent],
});
