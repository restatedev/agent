// Tool-grant rules shared by the runtime and the web app. Kept free of zod so
// browser code can import it without the schema library.

import type {AgentTools, ToolSelection} from "./index.js";

/** Whether a tool selection includes `name`. */
export function toolSelected(selection: ToolSelection, name: string): boolean {
  return selection.mode === "all" || selection.names.includes(name);
}

/**
 * Whether an MCP server's tools are available: its explicit grant decides,
 * otherwise the agent's `mcpDefault`.
 */
export function mcpServerGranted(tools: AgentTools, serverId: string): boolean {
  const grant = tools.mcp.find((item) => item.serverId === serverId);
  return grant
    ? grant.tools.mode === "all" || grant.tools.names.length > 0
    : tools.mcpDefault !== "disabled";
}
