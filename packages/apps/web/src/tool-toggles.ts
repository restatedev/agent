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
  return Boolean(
    grant && (grant.tools.mode === "all" || grant.tools.names.length),
  );
}

/** One opt-in grants the connection's tools; off removes only this Agent's grant. */
export function toggleConnection(
  tools: AgentTools,
  connectionId: string,
  enabled: boolean,
): AgentTools {
  const mcp = tools.mcp.filter((g) => g.connectionId !== connectionId);
  if (enabled) mcp.push({connectionId, tools: {mode: "all"}});
  return {...tools, mcp};
}
