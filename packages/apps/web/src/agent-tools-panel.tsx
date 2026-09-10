"use client";
import type {
  AgentProfile,
  AgentTools,
  ToolDescriptor,
  ToolSelection,
} from "@restate-agents/types";
import {useEffect, useState} from "react";
import type {AgentClient} from "./agent-client";
import {userClient} from "./user-client";
import {useUser} from "./user-context";

function Selection({
  label,
  value,
  tools,
  onChange,
  disabled,
}: {
  label: string;
  value: ToolSelection;
  tools: ToolDescriptor[];
  onChange: (value: ToolSelection) => void;
  disabled: boolean;
}) {
  // Retain explicit grants when discovery is temporarily unavailable.
  const catalog = [
    ...tools,
    ...(value.mode === "selected"
      ? value.names
          .filter((name) => !tools.some((t) => t.name === name))
          .map((name) => ({name, description: "Not in the current catalog"}))
      : []),
  ];
  return (
    <fieldset className="tool-selection" disabled={disabled}>
      <legend>{label}</legend>
      <label className="field-label">
        Access
        <select
          aria-label={`${label} access`}
          value={value.mode}
          onChange={(event) =>
            onChange(
              event.target.value === "all"
                ? {mode: "all"}
                : {mode: "selected", names: []},
            )
          }
        >
          <option value="selected">Selected tools only</option>
          <option value="all">All tools (including future tools)</option>
        </select>
      </label>
      {value.mode === "selected" && (
        <div className="tool-checkboxes">
          {!catalog.length && (
            <p className="empty-copy">
              No tools loaded. No tools are permitted.
            </p>
          )}
          {catalog.map((tool) => (
            <label key={tool.name} title={tool.description}>
              <input
                type="checkbox"
                checked={value.names.includes(tool.name)}
                onChange={(event) =>
                  onChange({
                    mode: "selected",
                    names: event.target.checked
                      ? [...value.names, tool.name]
                      : value.names.filter((name) => name !== tool.name),
                  })
                }
              />
              <span>
                {tool.name}
                <small>{tool.description}</small>
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
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
  const [remote, setRemote] = useState<Record<string, ToolDescriptor[]>>({});
  const [saving, setSaving] = useState(false);
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
    setSaving(true);
    try {
      await client.setTools(tools);
      await refresh();
      notify("Tool access saved for future turns");
    } catch (error) {
      notify(String(error), true);
    } finally {
      setSaving(false);
    }
  }
  if (!profile) return <p>Loading tool access…</p>;
  const permissions = profile.tools;
  return (
    <section className="settings-section">
      <div className="section-heading">
        <div>
          <span>
            <strong>Tool access</strong>
            <small>Only these tools are available to this agent</small>
          </span>
        </div>
      </div>
      <p className="empty-copy">
        Connections belong to your account. Enabling one here does not enable it
        for other agents. Changes apply to the next turn.
      </p>
      <Selection
        label="Built-in tools"
        value={permissions.builtin}
        tools={catalog.builtin}
        disabled={saving}
        onChange={(builtin) => void save({...permissions, builtin})}
      />
      <Selection
        label="Dynamic tools"
        value={permissions.dynamic}
        tools={catalog.dynamic}
        disabled={saving}
        onChange={(dynamic) => void save({...permissions, dynamic})}
      />
      {!user.profile.connections.length && (
        <p className="empty-copy">
          Add a connection from the account sidebar first.
        </p>
      )}
      {user.profile.connections.map((connection) => {
        const id = connection.server.id,
          grant = permissions.mcp.find((g) => g.connectionId === id);
        return (
          <div className="agent-connection" key={id}>
            <label className="check-label">
              <input
                type="checkbox"
                disabled={saving}
                checked={Boolean(grant)}
                onChange={(event) =>
                  void save({
                    ...permissions,
                    mcp: event.target.checked
                      ? [
                          ...permissions.mcp,
                          {
                            connectionId: id,
                            tools: {mode: "selected", names: []},
                          },
                        ]
                      : permissions.mcp.filter((g) => g.connectionId !== id),
                  })
                }
              />
              <strong>{id}</strong>
              <small>
                {connection.connected
                  ? "Credential available"
                  : "Authorization needed"}
              </small>
            </label>
            {grant && (
              <>
                <button
                  type="button"
                  className="button secondary small"
                  disabled={saving || !connection.connected}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      const tools = await userClient.discoverConnection(id);
                      setRemote((current) => ({...current, [id]: tools}));
                    } catch (error) {
                      notify(String(error), true);
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  Load available tools
                </button>
                <Selection
                  label={id}
                  value={grant.tools}
                  tools={remote[id] ?? connection.tools}
                  disabled={saving}
                  onChange={(tools) =>
                    void save({
                      ...permissions,
                      mcp: permissions.mcp.map((g) =>
                        g.connectionId === id ? {...g, tools} : g,
                      ),
                    })
                  }
                />
              </>
            )}
          </div>
        );
      })}
      {permissions.mcp
        .filter(
          (g) =>
            !user.profile.connections.some(
              (c) => c.server.id === g.connectionId,
            ),
        )
        .map((g) => (
          <div className="agent-connection" key={g.connectionId}>
            <span>{g.connectionId} · connection removed</span>
            <button
              type="button"
              className="button ghost small"
              disabled={saving}
              onClick={() =>
                void save({
                  ...permissions,
                  mcp: permissions.mcp.filter((item) => item !== g),
                })
              }
            >
              Remove grant
            </button>
          </div>
        ))}
    </section>
  );
}
