import type {
  AgentProfile,
  AgentTools,
  SubAgentConfig,
  ToolSelection,
} from "@restate-agents/types";
import {TerminalError} from "@restatedev/restate-sdk";

function subset(requested: ToolSelection, allowed: ToolSelection): boolean {
  return (
    allowed.mode === "all" ||
    (requested.mode === "selected" &&
      requested.names.every((name) => allowed.names.includes(name)))
  );
}

// A child has no children of its own and no independent scheduled turns.
const PARENT_ONLY_TOOLS = new Set([
  "createSubAgent",
  "messageSubAgent",
  "listSubAgents",
  "deleteSubAgent",
  "createSchedule",
  "listSchedules",
  "cancelSchedule",
]);

/** Copy creation-time configuration, with runtime-enforced attenuation. */
export function subAgentProfile(
  parent: AgentProfile,
  grants: AgentTools,
  config: SubAgentConfig,
  builtins: readonly string[],
): AgentProfile {
  const tools = structuredClone(config.tools ?? grants);
  const denied = !subset(tools.builtin, grants.builtin)
    ? "builtin"
    : !subset(tools.dynamic, grants.dynamic)
      ? "dynamic"
      : tools.mcp.find((grant) => {
          const allowed = grants.mcp.find(
            (g) => g.connectionId === grant.connectionId,
          );
          return !allowed || !subset(grant.tools, allowed.tools);
        });
  if (denied)
    throw new TerminalError(
      "Sub-agent tools cannot exceed the parent's current access: " +
        (typeof denied === "string"
          ? `${denied} selection is not permitted.`
          : `MCP connection ${JSON.stringify(denied.connectionId)} or its tool selection is not permitted.`) +
        " Built-in tools such as webSearch belong in builtin; dynamic names are service/handler IDs. Correct the selection, or use tools: null to inherit current access if no narrower restriction is needed.",
      {errorCode: 403},
    );
  // Remove inapplicable tools from both direct and PTC discovery. The child's
  // immutable grants should describe what it can actually do.
  tools.builtin = {
    mode: "selected",
    names: (tools.builtin.mode === "all"
      ? [...builtins]
      : tools.builtin.names
    ).filter((name) => !PARENT_ONLY_TOOLS.has(name)),
  };
  tools.mcpDefault = "disabled";
  const guardrails = structuredClone(parent.guardrails);
  for (const addition of config.guardrails ?? []) {
    const existing = guardrails.find((g) => g.id === addition.id);
    if (existing && existing.rule !== addition.rule)
      throw new TerminalError(
        "Sub-agent guardrails cannot replace inherited guardrails",
        {errorCode: 403},
      );
    if (!existing) guardrails.push(addition);
  }
  if (config.webSearchEnabled === true && !parent.webSearchEnabled)
    throw new TerminalError(
      "Sub-agent cannot enable web search when the parent has disabled it",
      {errorCode: 403},
    );
  const instructions = [
    parent.instructions,
    config.instructions
      ? `[Sub-agent task instructions]\n${config.instructions}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...(instructions ? {instructions} : {}),
    guardrails,
    memories: structuredClone(parent.memories),
    tools,
    webSearchEnabled: config.webSearchEnabled ?? parent.webSearchEnabled,
  };
}
