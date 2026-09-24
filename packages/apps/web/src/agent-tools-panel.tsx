"use client";
import type {
  AgentProfile,
  AgentTools,
  McpServer,
  ToolDescriptor,
  ToolSelection,
} from "@restate-agents/types";
import {
  mcpServerGranted,
  toolSelected,
} from "@restate-agents/types/tool-grants";
import {useEffect, useRef, useState} from "react";

import type {UiAgentClient} from "./agent-client";
import {errorMessage, type Notify} from "./format";
import {ToolSwitch} from "./switch";
import {toggleMcpServer, toggleTool} from "./tool-toggles";
import type {SaveProfile} from "./use-agent";

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
              checked={toolSelected(selection, name)}
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
  saveProfile,
  notify,
}: {
  client: UiAgentClient;
  profile?: AgentProfile;
  saveProfile: SaveProfile;
  notify: Notify;
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
        if (active) {
          setCatalog(result);
        }
      })
      .catch((error) => {
        if (active) {
          notify(errorMessage(error), true);
        }
      });
    return () => {
      active = false;
    };
  }, [client, notify]);

  async function save(tools: AgentTools) {
    if (savingRef.current) {
      return;
    }
    savingRef.current = true;
    setSaving(true);
    await saveProfile({tools}, "Tool access saved for the next turn");
    savingRef.current = false;
    setSaving(false);
  }

  if (!profile) {
    return <p>Loading tool access…</p>;
  }
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
            checked={mcpServerGranted(permissions, server.id)}
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
