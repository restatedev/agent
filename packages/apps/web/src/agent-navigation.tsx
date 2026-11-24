import type {AgentMetadata, ChildAgent} from "@restate-agents/types";
import {ArrowRight, ChevronDown, CornerLeftUp, Network} from "lucide-react";
import {useEffect, useRef} from "react";

function agentHref(agentId: string) {
  return `/?agent=${encodeURIComponent(agentId)}`;
}

/**
 * Lists sub-agents in a dropdown, so any number of them fits in the one-line
 * top bar. Closes on a click outside or Escape, like a native menu.
 */
function SubAgentMenu({childAgents}: {childAgents: ChildAgent[]}) {
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const details = menu.current;
      if (details?.open && !details.contains(event.target as Node)) {
        details.open = false;
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      const details = menu.current;
      if (event.key === "Escape" && details?.open) {
        details.open = false;
        details.querySelector("summary")?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <details className="agent-menu" ref={menu}>
      <summary className="agent-link">
        <Network aria-hidden="true" />
        Sub-agents
        <span className="agent-menu-count">{childAgents.length}</span>
        <ChevronDown aria-hidden="true" className="agent-menu-chevron" />
      </summary>
      <div className="agent-menu-list">
        {childAgents.map((child) => (
          <a
            key={child.agentId}
            href={agentHref(child.agentId)}
            title={child.agentId}
          >
            {child.name}
          </a>
        ))}
      </div>
    </details>
  );
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
    <nav className="agent-navigation" aria-label="Agent navigation">
      <form className="agent-switcher" action="/" method="get">
        <label htmlFor="agent-id">Agent ID</label>
        <input
          id="agent-id"
          name="agent"
          defaultValue={agentId}
          maxLength={256}
          placeholder="Agent ID"
          required
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" aria-label="Open agent" title="Open agent">
          <ArrowRight aria-hidden="true" />
        </button>
      </form>
      {parentAgentId && (
        <a
          className="agent-link"
          href={agentHref(parentAgentId)}
          title={parentAgentId}
        >
          <CornerLeftUp aria-hidden="true" />
          Parent
        </a>
      )}
      {childAgents.length > 0 && <SubAgentMenu childAgents={childAgents} />}
    </nav>
  );
}
