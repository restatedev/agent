import type {AgentTools, ToolSelection} from "@restate-agents/types";

export function toolEnabled(selection: ToolSelection, name: string) {
  return selection.mode === "all" || selection.names.includes(name);
}

export function toggleTool(
  selection: ToolSelection,
  catalog: string[],
  name: string,
  enabled: boolean,
): ToolSelection {
  const names = new Set(selection.mode === "all" ? catalog : selection.names);
  if (enabled) names.add(name);
  else names.delete(name);
  return {mode: "selected", names: [...names]};
}

export function mcpServerEnabled(tools: AgentTools, serverId: string) {
  const grant = tools.mcp.find((item) => item.connectionId === serverId);
  return grant
    ? grant.tools.mode === "all" || grant.tools.names.length > 0
    : tools.mcpDefault !== "disabled";
}

/** An explicit selection overrides the default for one configured server. */
export function toggleMcpServer(
  tools: AgentTools,
  serverId: string,
  enabled: boolean,
): AgentTools {
  const mcp = tools.mcp.filter((item) => item.connectionId !== serverId);
  mcp.push({
    connectionId: serverId,
    tools: enabled ? {mode: "all"} : {mode: "selected", names: []},
  });
  return {...tools, mcp};
}
