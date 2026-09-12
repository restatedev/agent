"use client";
import type {
  AgentProfile,
  AgentTools,
  ToolDescriptor,
  ToolSelection,
} from "@restate-agents/types";
import {useEffect, useRef, useState} from "react";
import type {AgentClient} from "./agent-client";
import {MCP_SERVER_PRESETS} from "./mcp-presets";
import {
  connectionEnabled,
  toggleConnection,
  toggleTool,
  toolEnabled,
} from "./tool-toggles";
import {useUser} from "./user-context";

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
  const user = useUser();
  const [catalog, setCatalog] = useState<{
    builtin: ToolDescriptor[];
    dynamic: ToolDescriptor[];
  }>({builtin: [], dynamic: []});
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
      await client.setTools(tools);
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
      <p className="empty-copy">
        Authorized connectors are enabled automatically each turn. Switch off
        any this agent should not use; your opt-outs are remembered.
      </p>
      <div className="agent-tool-list">
        {user.profile.connections.map((connection) => {
          const id = connection.server.id;
          const label =
            MCP_SERVER_PRESETS.find((preset) => preset.id === id)?.label ?? id;
          const ready =
            connection.connected || connection.server.auth.type === "none";
          const enabled = ready && connectionEnabled(permissions, id);
          return (
            <div key={id}>
              <ToolSwitch
                label={label}
                checked={enabled}
                disabled={saving || (!ready && !enabled)}
                onChange={(on) =>
                  void save(toggleConnection(permissions, id, on))
                }
              />
              {!ready && (
                <a className="agent-tool-connect" href="/">
                  Authorize {label} in Profile &amp; connectors
                </a>
              )}
            </div>
          );
        })}
      </div>
      {!user.profile.connections.length && (
        <p className="empty-copy">No connections yet.</p>
      )}
      <a className="agent-tool-connect" href="/">
        Manage profile &amp; connectors
      </a>
      {permissions.mcp
        .filter(
          (g) =>
            !user.profile.connections.some(
              (c) => c.server.id === g.connectionId,
            ),
        )
        .map((g) => (
          <ToolSwitch
            key={g.connectionId}
            label={`${g.connectionId} (removed)`}
            checked={connectionEnabled(permissions, g.connectionId)}
            disabled={saving}
            onChange={() =>
              void save(toggleConnection(permissions, g.connectionId, false))
            }
          />
        ))}
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
