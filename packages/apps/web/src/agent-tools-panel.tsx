"use client";
import type {
  AgentProfile,
  AgentTools,
  McpServer,
  ToolDescriptor,
  ToolSelection,
} from "@restate-agents/types";
import {useEffect, useRef, useState} from "react";

import type {AgentClient} from "./agent-client";
import {
  mcpServerEnabled,
  toggleMcpServer,
  toggleTool,
  toolEnabled,
} from "./tool-toggles";

function ToolSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="agent-tool-toggle">
      <span>{label}</span>
      <button
        type="button"
        className="web-search-toggle"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="web-search-toggle-track" aria-hidden="true">
          <span />
        </span>
        {checked ? "Enabled" : "Disabled"}
      </button>
    </div>
  );
}

function ToolGroup({
  label,
  selection,
  catalog,
  disabled,
  onChange,
}: {
  label: string;
  selection: ToolSelection;
  catalog: ToolDescriptor[];
  disabled: boolean;
  onChange: (selection: ToolSelection) => void;
}) {
  // Keep saved names visible even if discovery is temporarily unavailable.
  const names = [
    ...new Set([
      ...catalog.map((tool) => tool.name),
      ...(selection.mode === "selected" ? selection.names : []),
    ]),
  ];
  return (
    <details className="agent-tool-group">
      <summary>{label}</summary>
      {names.length === 0 ? (
        <p className="empty-copy">No tools available.</p>
      ) : (
        <div className="agent-tool-list">
          {names.map((name) => (
            <ToolSwitch
              key={name}
              label={name}
              checked={toolEnabled(selection, name)}
              disabled={disabled}
              onChange={(enabled) =>
                onChange(toggleTool(selection, names, name, enabled))
              }
            />
          ))}
        </div>
      )}
    </details>
  );
}

export function AgentToolsPanel({
  client,
  profile,
  refresh,
  notify,
}: {
  client: AgentClient;
  profile?: AgentProfile;
  refresh: () => Promise<AgentProfile>;
  notify: (message: string, error?: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<{
    builtin: ToolDescriptor[];
    dynamic: ToolDescriptor[];
    mcp: McpServer[];
  }>({builtin: [], dynamic: [], mcp: []});
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  useEffect(() => {
    let active = true;
    client
      .toolCatalog()
      .then((result) => {
        if (active) setCatalog(result);
      })
      .catch((error) => {
        if (active) notify(String(error), true);
      });
    return () => {
      active = false;
    };
  }, [client, notify]);

  async function save(tools: AgentTools) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await client.updateProfile({tools});
      await refresh();
      notify("Tool access saved for the next turn");
    } catch (error) {
      notify(String(error), true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (!profile) return <p>Loading tool access…</p>;
  const permissions = profile.tools;
  return (
    <section className="settings-section">
      <div className="section-heading">
        <strong>Tool access</strong>
      </div>
      <p className="empty-copy">Tool selections apply to the next turn.</p>
      <div className="agent-tool-list">
        {catalog.mcp.map((server) => (
          <ToolSwitch
            key={server.id}
            label={server.id}
            checked={mcpServerEnabled(permissions, server.id)}
            disabled={saving}
            onChange={(enabled) =>
              void save(toggleMcpServer(permissions, server.id, enabled))
            }
          />
        ))}
      </div>
      <ToolGroup
        label="Built-in tools"
        selection={permissions.builtin}
        catalog={catalog.builtin}
        disabled={saving}
        onChange={(builtin) => void save({...permissions, builtin})}
      />
      <ToolGroup
        label="Dynamic tools"
        selection={permissions.dynamic}
        catalog={catalog.dynamic}
        disabled={saving}
        onChange={(dynamic) => void save({...permissions, dynamic})}
      />
    </section>
  );
}
