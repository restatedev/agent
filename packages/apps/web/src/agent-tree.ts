import type {UserAgent} from "@restate-agents/types";

export function agentSubtree(agents: UserAgent[], id: string): Set<string> {
  const ids = new Set([id]);
  for (let size = 0; size !== ids.size; ) {
    size = ids.size;
    for (const agent of agents)
      if (agent.parentAgentId && ids.has(agent.parentAgentId))
        ids.add(agent.agentId);
  }
  return ids;
}

/** Stable, defensive flattening: missing parents/cycles never hide an agent. */
export function agentTree(agents: UserAgent[], collapsed: Set<string>) {
  const rows: Array<{agent: UserAgent; depth: number; children: string[]}> = [];
  const seen = new Set<string>();
  function visit(agent: UserAgent, depth: number) {
    if (seen.has(agent.agentId)) return;
    seen.add(agent.agentId);
    const children = agents.filter(
      (a) => a.parentAgentId === agent.agentId && !seen.has(a.agentId),
    );
    rows.push({
      agent,
      depth,
      children: [...agentSubtree(agents, agent.agentId)].filter(
        (id) => id !== agent.agentId,
      ),
    });
    if (collapsed.has(agent.agentId)) {
      for (const id of agentSubtree(agents, agent.agentId)) seen.add(id);
    } else for (const child of children) visit(child, depth + 1);
  }
  for (const agent of agents)
    if (
      !agent.parentAgentId ||
      !agents.some((a) => a.agentId === agent.parentAgentId)
    )
      visit(agent, 0);
  for (const agent of agents) visit(agent, 0);
  return rows;
}
