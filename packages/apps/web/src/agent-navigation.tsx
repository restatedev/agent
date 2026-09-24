import type {AgentMetadata, ChildAgent} from "@restate-agents/types";

function agentHref(agentId: string) {
  return `/?agent=${encodeURIComponent(agentId)}`;
}

/**
 * Opens another agent by ID, or its parent or children. Every link is a full
 * page load, so each conversation mounts with its own long poll.
 */
export function AgentNavigation({
  agentId,
  metadata,
  childAgents,
}: {
  agentId: string;
  metadata?: AgentMetadata;
  childAgents: ChildAgent[];
}) {
  const parentAgentId = metadata?.parentAgentId;
  return (
    <nav className="demo-navigation" aria-label="Agent navigation">
      <form action="/" method="get">
        <label htmlFor="agent-id">Agent ID</label>
        <input
          id="agent-id"
          name="agent"
          defaultValue={agentId}
          maxLength={256}
          required
        />
        <button type="submit" className="button secondary">
          Open agent
        </button>
      </form>
      {parentAgentId && (
        <a href={agentHref(parentAgentId)}>Parent conversation</a>
      )}
      {childAgents.map((child) => (
        <a key={child.agentId} href={agentHref(child.agentId)}>
          {child.name}
        </a>
      ))}
    </nav>
  );
}
