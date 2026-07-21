// Entrypoint: a conversational weather agent, wired from two Restate
// VirtualObjects.
//
//   - Agent (./agent): the conversation object, owning ALL conversation data —
//     the clean transcript (one user message per ask, one assistant summary per
//     turn) plus a detailed per-turn trace, readable via `trace(turnId)` (live,
//     mid-turn too). `ask` starts a turn when idle; a message arriving mid-turn
//     is queued, or — by a naive keyword check in this demo — steers or
//     interrupts the running turn. Explicit `interrupt`/`steer` handlers exist
//     alongside for clients with real affordances (a stop button, an edit box)
//     instead of keyword guessing.
//   - Turn (./turn): the stateless turn loop. Drives the closed
//     model->tool->model loop, reporting each detailed step into the Agent's
//     per-turn trace and exactly one summary into the transcript.
//
// Set OPENAI_API_KEY in the environment before running.

import {serve} from "@restatedev/restate-sdk";
import {Agent} from "./agent";
import {Turn} from "./turn";

serve({
  services: [Agent, Turn],
});
