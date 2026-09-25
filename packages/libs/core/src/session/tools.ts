// The built-in tools. Definitions live in `tools/`, grouped by what they
// touch; the agent SDK provides the loop mechanics (search, timers, human
// approval, cancellation and programs). A tool's `describe` is a fixed label
// for the public transcript: raw arguments stay in the journal.

import {
  cancelOperationTool,
  humanApprovalTool,
  searchToolsTool,
  sleepTool,
} from "@restate-agents/core";
import {programTool} from "@restate-agents/core/program";
import {webSearch} from "@restate-agents/core/web-search";

import * as state from "./tools/agent-state.js";
import {getWeather} from "./tools/local.js";
import * as sandbox from "./tools/sandbox.js";
import * as subAgents from "./tools/sub-agents.js";
import type {TurnTool} from "./turn-context.js";

/** Built-in tools by model-facing name. */
export const builtins: Record<string, TurnTool> = {
  searchTools: searchToolsTool({describe: {name: "Searched tools"}}),
  getWeather,
  // No API key: Tavily's free, rate-limited keyless access.
  webSearch: webSearch({describe: {name: "Searched the web"}}),
  sleep: sleepTool({maxMilliseconds: 300_000}),
  humanApproval: humanApprovalTool(),
  cancelOperation: cancelOperationTool(),
  manageMemory: state.manageMemory,
  createSubAgent: subAgents.createSubAgent,
  messageSubAgent: subAgents.messageSubAgent,
  deleteSubAgent: subAgents.deleteSubAgent,
  listSubAgents: subAgents.listSubAgents,
  createSchedule: state.createSchedule,
  cancelSchedule: state.cancelSchedule,
  listSchedules: state.listSchedules,
  listFiles: sandbox.listFiles,
  readFile: sandbox.readFile,
  writeFile: sandbox.writeFile,
  executeCommand: sandbox.executeCommand,
  executeProgram: programTool({
    describe: {name: "Coordinated tools with JavaScript"},
  }),
};

/** Names reserved by built-in tools and unavailable to dynamic discovery. */
export const names = Object.keys(builtins);

/**
 * `AGENT_PTC_ENABLED=false` hides programs from new turns. A turn journals the
 * setting it started with (see turn-tools.ts), so its replay cannot diverge.
 */
export const programsEnabled = () => process.env.AGENT_PTC_ENABLED !== "false";

/** Every built-in tool, as the tool-permission UI lists them. */
export function builtinCatalog(): {name: string; description: string}[] {
  return Object.entries(builtins)
    .filter(([name]) => name !== "executeProgram" || programsEnabled())
    .map(([name, {description}]) => ({name, description}));
}
