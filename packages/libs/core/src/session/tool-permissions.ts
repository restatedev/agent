import type {AgentTools, ToolSelection} from "@restate-agents/types";
import type {DiscoveredAgentTool} from "./dynamic-tools.js";
import type {McpAgentTool} from "./mcp-tools.js";

export function selected(selection: ToolSelection, name: string): boolean {
  return selection.mode === "all" || selection.names.includes(name);
}
/** Dynamic permissions use stable service/handler identity, not a mutable alias. */
export function dynamicToolId(tool: DiscoveredAgentTool): string {
  return `${tool.target.service}/${tool.target.handler}`;
}
export function toolAllowed(
  name: string,
  permissions: AgentTools,
  discovered: DiscoveredAgentTool[],
  mcp: McpAgentTool[],
  builtins: readonly string[],
): boolean {
  if (builtins.includes(name)) return selected(permissions.builtin, name);
  const dynamic = discovered.find((t) => t.name === name);
  if (dynamic) return selected(permissions.dynamic, dynamicToolId(dynamic));
  const remote = mcp.find((t) => t.name === name);
  if (!remote) return false;
  const grant = permissions.mcp.find(
    (g) => g.connectionId === remote.target.server.id,
  );
  return Boolean(grant && selected(grant.tools, remote.target.remoteName));
}
