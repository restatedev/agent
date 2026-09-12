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

export function connectionEnabled(tools: AgentTools, connectionId: string) {
  const grant = tools.mcp.find((g) => g.connectionId === connectionId);
  return !grant || grant.tools.mode === "all" || grant.tools.names.length > 0;
}

/** Off must be explicit: omission means default-on for authorized connections. */
export function toggleConnection(
  tools: AgentTools,
  connectionId: string,
  enabled: boolean,
): AgentTools {
  const mcp = tools.mcp.filter((g) => g.connectionId !== connectionId);
  mcp.push({
    connectionId,
    tools: enabled ? {mode: "all"} : {mode: "selected", names: []},
  });
  return {...tools, mcp};
}
