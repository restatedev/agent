import type {AgentTools, ToolSelection} from "@restate-agents/types";

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
