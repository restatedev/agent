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

/** Copy creation-time configuration, with runtime-enforced attenuation. */
export function subAgentProfile(
  parent: AgentProfile,
  grants: AgentTools,
  config: SubAgentConfig,
  builtins: readonly string[],
): AgentProfile {
  const tools = structuredClone(config.tools ?? grants);
  if (
    !subset(tools.builtin, grants.builtin) ||
    !subset(tools.dynamic, grants.dynamic) ||
    tools.mcp.some((grant) => {
      const allowed = grants.mcp.find(
        (g) => g.connectionId === grant.connectionId,
      );
      return !allowed || !subset(grant.tools, allowed.tools);
    })
  )
    throw new TerminalError(
      "Sub-agent tools cannot exceed the parent's current access",
      {errorCode: 403},
    );
  // One level of delegation for now. PTC still sees only these allowed tools.
  tools.builtin = {
    mode: "selected",
    names: (tools.builtin.mode === "all"
      ? [...builtins]
      : tools.builtin.names
    ).filter((name) => name !== "createSubAgent"),
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
    tools,
    webSearchEnabled: config.webSearchEnabled ?? parent.webSearchEnabled,
  };
}
