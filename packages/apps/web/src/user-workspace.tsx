"use client";
import type {McpServer, UserProfile} from "@restate-agents/types";
import {Check, LogOut, Plug, Plus} from "lucide-react";
import {useCallback, useEffect, useRef, useState} from "react";
import {App} from "./app";
import {MCP_SERVER_PRESETS} from "./mcp-presets";
import {useAgentInbox} from "./use-agent-inbox";
import {userClient} from "./user-client";
import {UserContext, useUser} from "./user-context";

export function UserWorkspace({
  initialUser,
  initialAgentId,
}: {
  initialUser: UserProfile;
  initialAgentId?: string;
}) {
  const [profile, setProfile] = useState(initialUser);
  const [selected, setSelected] = useState(initialAgentId);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const creationId = useRef<string | undefined>(undefined);
  const {unread, markSeen, unavailable} = useAgentInbox(
    profile.identity.userId,
  );
  const refresh = useCallback(async () => {
    const next = await userClient.profile();
    setProfile(next);
  }, []);
  useEffect(() => {
    const reload = () => {
      void refresh().catch((error) => setError(String(error)));
    };
    const timer = window.setInterval(reload, 15000);
    window.addEventListener("focus", reload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", reload);
    };
  }, [refresh]);
  useEffect(() => {
    const read = () => {
      const id = new URL(window.location.href).searchParams.get("agent");
      setSelected(id ?? undefined);
    };
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  function select(id?: string) {
    setSelected(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("agent", id);
    else url.searchParams.delete("agent");
    window.history.pushState(null, "", url);
  }
  const agent = profile.agents.find((agent) => agent.agentId === selected);
  return (
    <UserContext.Provider value={{profile, refresh}}>
      <div className="user-workspace">
        <aside className="agents-sidebar">
          <div className="account-identity">
            <strong>{profile.identity.displayName}</strong>
            <small>{profile.identity.email}</small>
          </div>
          <p className="eyebrow">Agents</p>
          <nav aria-label="Your agents">
            {profile.agents.map((agent) => (
              <button
                type="button"
                key={agent.agentId}
                data-active={selected === agent.agentId}
                data-unread={unread.has(agent.agentId)}
                aria-label={
                  unread.has(agent.agentId)
                    ? `${agent.name} — new response`
                    : agent.name
                }
                title={
                  unread.has(agent.agentId)
                    ? "Turn finished — new response"
                    : undefined
                }
                onClick={() => select(agent.agentId)}
              >
                <span className="agent-name">{agent.name}</span>
                {unread.has(agent.agentId) && (
                  <span className="agent-unread-badge" aria-hidden="true">
                    <span className="agent-unread-dot" />
                    New
                  </span>
                )}
              </button>
            ))}
          </nav>
          {unavailable && (
            <small role="status" className="agent-notification-warning">
              Checking for new responses… reconnecting
            </small>
          )}
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (creating || !name.trim()) return;
              setCreating(true);
              setError("");
              creationId.current ??= crypto.randomUUID();
              try {
                const created = await userClient.createAgent(
                  name.trim(),
                  creationId.current,
                );
                await refresh();
                setName("");
                creationId.current = undefined;
                select(created.agentId);
              } catch (error) {
                setError(String(error));
              } finally {
                setCreating(false);
              }
            }}
          >
            <input
              aria-label="New agent name"
              placeholder="Agent name"
              maxLength={100}
              value={name}
              disabled={creating}
              onChange={(event) => {
                setName(event.target.value);
                creationId.current = undefined;
              }}
            />
            <button
              type="submit"
              className="button secondary small"
              disabled={creating || !name.trim()}
            >
              <Plus />
              {creating ? "Creating…" : "New agent"}
            </button>
          </form>
          <button
            type="button"
            className="button ghost small"
            data-active={!selected}
            onClick={() => select()}
          >
            <Plug />
            Connections
          </button>
          <p className="empty-copy">
            Each agent has its own conversation and tool access.
          </p>
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="button ghost small">
              <LogOut />
              Sign out
            </button>
          </form>
        </aside>
        <div className="agent-workspace">
          {agent ? (
            <App
              key={agent.agentId}
              initialAgentId={agent.agentId}
              agentName={agent.name}
              onTurnSeen={markSeen}
            />
          ) : selected ? (
            <div className="account-pane">
              <h1>Agent not found</h1>
              <p>Select one of your agents from the sidebar.</p>
            </div>
          ) : (
            <Connections />
          )}
        </div>
      </div>
    </UserContext.Provider>
  );
}

function Connections() {
  const {profile, refresh} = useUser();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [bearer, setBearer] = useState<{
      id: string;
      authRequestId: string;
    } | null>(null),
    [token, setToken] = useState("");
  const [server, setServer] = useState<McpServer>({
    id: "",
    type: "http",
    url: "",
    protocol: "stateless",
    auth: {type: "oauth"},
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("mcpAuth");
    if (result) {
      setNotice(
        result === "completed"
          ? "Connection authorized. Enable its tools in an agent’s Context tab."
          : "Authorization failed. Try again.",
      );
      url.searchParams.delete("mcpAuth");
      window.history.replaceState(null, "", url);
    }
  }, []);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function add(value: McpServer) {
    const result = await userClient.upsertConnection(value);
    if (!result.accepted) throw new Error(result.error);
    setNotice(
      `Configured ${value.id}. Select its tools separately for each agent.`,
    );
  }
  return (
    <main className="account-pane">
      <p className="eyebrow">Your account</p>
      <h1>Connections</h1>
      <p>
        Authorize an account once, then choose which tools each agent may use.
        Disconnecting here revokes access for all your agents.
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="mcp-preset-list">
        {MCP_SERVER_PRESETS.map((preset) => {
          const added = profile.connections.some(
              (c) => c.server.id === preset.id,
            ),
            Icon = preset.icon;
          return (
            <button
              type="button"
              className="mcp-preset-button"
              key={preset.id}
              disabled={busy || added}
              data-added={added}
              onClick={() =>
                void run(() =>
                  add({
                    id: preset.id,
                    type: "http",
                    url: preset.url,
                    protocol: preset.protocol,
                    auth: {type: preset.authType},
                  }),
                )
              }
            >
              <span className="mcp-preset-icon" data-provider={preset.id}>
                <Icon />
                {added && (
                  <span className="mcp-preset-check">
                    <Check />
                  </span>
                )}
              </span>
              <span>
                <strong>{preset.label}</strong>
                <small>{added ? "Added" : preset.setup}</small>
              </span>
            </button>
          );
        })}
      </div>
      <div className="account-connections">
        {profile.connections.map(({server: connection, connected, tools}) => (
          <article
            className="compact-card account-connection"
            key={connection.id}
          >
            <div>
              <strong>{connection.id}</strong>
              <span>{connection.url}</span>
              <small>
                {connection.protocol} · {connection.auth.type} ·{" "}
                {connected
                  ? connection.auth.type === "none"
                    ? "No authorization required"
                    : "Credential saved"
                  : "Authorization needed"}
              </small>
            </div>
            <div className="connection-actions">
              {connection.auth.type !== "none" && (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const request = await userClient.beginAuthorization(
                        connection.id,
                      );
                      if (connection.auth.type === "bearer") {
                        setToken("");
                        setBearer({
                          id: connection.id,
                          authRequestId: request.authRequestId,
                        });
                        return;
                      }
                      const result = await userClient.startAuthorization(
                        request.authRequestId,
                      );
                      if (result.status === "redirect")
                        window.location.assign(result.authorizationUrl);
                      else setNotice("Authorization completed");
                    })
                  }
                >
                  {connected ? "Reauthorize" : "Authorize"}
                </button>
              )}
              <button
                type="button"
                className="button secondary small"
                disabled={busy || !connected}
                onClick={() =>
                  void run(async () => {
                    const catalog = await userClient.discoverConnection(
                      connection.id,
                    );
                    setNotice(
                      `${connection.id}: ${catalog.length} tools available. Select tools in the agent’s Context tab.`,
                    );
                  })
                }
              >
                Discover tools{tools.length ? ` (${tools.length})` : ""}
              </button>
              {connected && connection.auth.type !== "none" && (
                <button
                  type="button"
                  className="button ghost small"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Disconnect ${connection.id} for all your agents?`,
                      )
                    )
                      void run(() =>
                        userClient.disconnectConnection(connection.id),
                      );
                  }}
                >
                  Disconnect
                </button>
              )}
              <button
                type="button"
                className="button ghost small"
                disabled={busy}
                onClick={() => {
                  setServer({
                    id: connection.id,
                    type: connection.type,
                    url: connection.url,
                    protocol: connection.protocol,
                    auth: connection.auth,
                  });
                  setNotice(
                    "Editing the connection below. Changing it clears its authorization.",
                  );
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="button ghost small"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${connection.id} from your account? All agents lose this connection.`,
                    )
                  )
                    void run(() => userClient.removeConnection(connection.id));
                }}
              >
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
      {bearer && (
        <form
          className="mcp-server-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              if (
                !(await userClient.completeBearer(bearer.authRequestId, token))
              )
                throw new Error("Authorization expired; try again");
              setToken("");
              setBearer(null);
              setNotice("Token saved");
            });
          }}
        >
          <label>
            Personal token for {bearer.id}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              required
            />
          </label>
          <div className="connection-actions">
            <button
              type="submit"
              className="button secondary small"
              disabled={busy}
            >
              Save token
            </button>
            <button
              className="button ghost small"
              type="button"
              onClick={() => {
                setToken("");
                setBearer(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <details className="custom-connection" open={Boolean(server.id)}>
        <summary>Custom connection / edit configuration</summary>
        <form
          className="mcp-server-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await add(server);
              setServer({
                id: "",
                type: "http",
                url: "",
                protocol: "stateless",
                auth: {type: "oauth"},
              });
            });
          }}
        >
          <label>
            Connection ID
            <input
              required
              value={server.id}
              onChange={(event) =>
                setServer({...server, id: event.target.value})
              }
            />
          </label>
          <label>
            Server URL
            <input
              type="url"
              required
              value={server.url}
              onChange={(event) =>
                setServer({...server, url: event.target.value})
              }
            />
          </label>
          <div className="form-grid two">
            <label>
              Protocol
              <select
                value={server.protocol}
                onChange={(event) =>
                  setServer({
                    ...server,
                    protocol: event.target.value as McpServer["protocol"],
                  })
                }
              >
                <option value="stateless">Stateless</option>
                <option value="stateful">Stateful</option>
              </select>
            </label>
            <label>
              Authentication
              <select
                value={server.auth.type}
                onChange={(event) =>
                  setServer({
                    ...server,
                    auth: {
                      type: event.target.value as McpServer["auth"]["type"],
                    },
                  })
                }
              >
                <option value="oauth">OAuth</option>
                <option value="bearer">Bearer token</option>
                <option value="none">No authentication</option>
              </select>
            </label>
          </div>
          <button
            type="submit"
            className="button secondary small"
            disabled={busy}
          >
            Add or update connection
          </button>
        </form>
      </details>
    </main>
  );
}
