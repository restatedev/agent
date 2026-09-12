"use client";
import type {McpServer, UserProfile} from "@restate-agents/types";
import {
  Check,
  ChevronDown,
  ChevronRight,
  LogOut,
  Plug,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {useCallback, useEffect, useRef, useState} from "react";
import {App} from "./app";
import {agentSubtree, agentTree} from "./agent-tree";
import {MCP_SERVER_PRESETS} from "./mcp-presets";
import {useAgentInbox} from "./use-agent-inbox";
import {useWorkspace, WorkspaceCacheContext} from "./use-workspace";
import {userClient} from "./user-client";
import {UserContext, useUser} from "./user-context";

export function UserWorkspace({
  initialUser,
  initialAgentId,
}: {
  initialUser: UserProfile;
  initialAgentId?: string;
}) {
  const [selected, setSelected] = useState(initialAgentId);
  const {cache, state} = useWorkspace(initialUser, selected);
  const profile = state.profile;
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [deleting, setDeleting] = useState<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const refreshVersion = useRef(0);
  const creationId = useRef<string | undefined>(undefined);
  const {unread, markSeen, unavailable} = useAgentInbox(
    profile.identity.userId,
    state.completions,
    state.status === "failed",
  );
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const next = await userClient.profile();
    if (version === refreshVersion.current) cache.setProfile(next);
  }, [cache]);
  useEffect(() => {
    const read = () => {
      const id = new URL(window.location.href).searchParams.get("agent");
      setSelected(id ?? undefined);
    };
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  useEffect(() => {
    // Also reveal children selected through browser back/forward navigation.
    if (selected)
      setCollapsed((previous) => {
        const next = new Set(
          [...previous].filter(
            (parent) => !agentSubtree(profile.agents, parent).has(selected),
          ),
        );
        return next.size === previous.size ? previous : next;
      });
  }, [selected, profile.agents]);
  function select(id?: string) {
    // A direct child link/navigation should reveal its row even in a folded tree.
    if (id)
      setCollapsed(
        (previous) =>
          new Set(
            [...previous].filter(
              (parent) => !agentSubtree(profile.agents, parent).has(id),
            ),
          ),
      );
    setSelected(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("agent", id);
    else url.searchParams.delete("agent");
    window.history.pushState(null, "", url);
  }
  const agent = profile.agents.find((agent) => agent.agentId === selected);
  async function deleteAgent(agentId: string, agentName: string) {
    if (
      deleting ||
      !window.confirm(
        `Delete “${agentName}” and all its sub-agents?\n\nThis removes the entire subtree, stops their work, cancels their schedules and deletes their sandbox files. Your shared connections and memories are kept. Conversation records remain stored internally; this is not a permanent data purge.`,
      )
    )
      return;
    setDeleting(agentId);
    setError("");
    try {
      await userClient.deleteAgent(agentId);
      ++refreshVersion.current; // Ignore profile reads started before deletion.
      const current = cache.getSnapshot().profile;
      const removed = agentSubtree(current.agents, agentId);
      cache.setProfile({
        ...current,
        agents: current.agents.filter((a) => !removed.has(a.agentId)),
      });
      if (selectedRef.current && removed.has(selectedRef.current)) select();
    } catch (error) {
      setError(String(error));
    } finally {
      setDeleting(undefined);
    }
  }
  return (
    <WorkspaceCacheContext.Provider value={cache}>
      <UserContext.Provider value={{profile, refresh}}>
        <div className="user-workspace">
          <aside className="agents-sidebar">
            <div className="account-identity">
              <strong>{profile.identity.displayName}</strong>
              <small>{profile.identity.email}</small>
            </div>
            <div className="agents-heading">
              <p className="eyebrow">Agents</p>
              <span className="agent-count">{profile.agents.length}</span>
            </div>
            <nav aria-label="Your agents">
              {agentTree(profile.agents, collapsed).map(
                ({agent, depth, children}) => (
                  <div
                    className="agent-list-row"
                    key={agent.agentId}
                    data-active={selected === agent.agentId}
                    style={{marginLeft: Math.min(depth, 8) * 16}}
                  >
                    {children.length > 0 && (
                      <button
                        type="button"
                        className="agent-tree-toggle"
                        aria-label={`${collapsed.has(agent.agentId) ? "Expand" : "Collapse"} ${agent.name} sub-agents`}
                        aria-expanded={!collapsed.has(agent.agentId)}
                        title={
                          children.some((id) => unread.has(id))
                            ? "Sub-agent has a new response"
                            : "Show or hide sub-agents"
                        }
                        data-unread={children.some((id) => unread.has(id))}
                        onClick={() =>
                          setCollapsed((previous) => {
                            const next = new Set(previous);
                            if (next.has(agent.agentId))
                              next.delete(agent.agentId);
                            else next.add(agent.agentId);
                            return next;
                          })
                        }
                      >
                        {collapsed.has(agent.agentId) ? (
                          <ChevronRight size={14} />
                        ) : (
                          <ChevronDown size={14} />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      className="agent-select"
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
                          : agent.name
                      }
                      onClick={() => select(agent.agentId)}
                    >
                      <span className="agent-avatar" aria-hidden="true">
                        🤖
                        {unread.has(agent.agentId) && (
                          <span className="agent-unread-dot" />
                        )}
                      </span>
                      <span className="agent-name">
                        {agent.name}
                        {agent.parentAgentId && (
                          <small className="sub-agent-label">Sub-agent</small>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="agent-delete"
                      aria-label={`Delete ${agent.name}`}
                      title={`Delete ${agent.name}`}
                      disabled={deleting !== undefined}
                      onClick={() =>
                        void deleteAgent(agent.agentId, agent.name)
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ),
              )}
            </nav>
            {unavailable && (
              <small role="status" className="agent-notification-warning">
                Checking for new responses… reconnecting
              </small>
            )}
            {!showCreate ? (
              <button
                type="button"
                className="new-agent-button"
                onClick={() => setShowCreate(true)}
              >
                <Plus size={17} /> New agent
              </button>
            ) : (
              <form
                className="new-agent-form"
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
                    setShowCreate(false);
                    select(created.agentId);
                  } catch (error) {
                    setError(String(error));
                  } finally {
                    setCreating(false);
                  }
                }}
              >
                <input
                  ref={(input) => {
                    input?.focus();
                  }}
                  aria-label="New agent name"
                  placeholder="Name your agent…"
                  maxLength={100}
                  value={name}
                  disabled={creating}
                  onChange={(event) => {
                    setName(event.target.value);
                    creationId.current = undefined;
                  }}
                />
                <div className="new-agent-actions">
                  <button
                    type="submit"
                    className="button secondary small"
                    disabled={creating || !name.trim()}
                  >
                    <span aria-hidden="true">🤖</span>
                    {creating ? "Creating…" : "Create agent"}
                  </button>
                  <button
                    type="button"
                    className="button ghost small"
                    aria-label="Cancel creating agent"
                    disabled={creating}
                    onClick={() => setShowCreate(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
              </form>
            )}
            <button
              type="button"
              className="button ghost small"
              data-active={!selected}
              onClick={() => select()}
            >
              <Plug />
              Profile &amp; connectors
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
            {profile.agents
              .filter(
                (a) =>
                  a.agentId === selected ||
                  Object.hasOwn(state.agents, a.agentId),
              )
              .map((a) => (
                <div
                  key={a.agentId}
                  hidden={a.agentId !== selected}
                  className="retained-agent-view"
                >
                  <App
                    initialAgentId={a.agentId}
                    agentName={a.name}
                    active={a.agentId === selected}
                    onTurnSeen={markSeen}
                  />
                </div>
              ))}
            {!agent &&
              (selected ? (
                <div className="account-pane">
                  <h1>Agent not found</h1>
                  <p>Select one of your agents from the sidebar.</p>
                </div>
              ) : (
                <ProfileAndConnectors />
              ))}
          </div>
        </div>
      </UserContext.Provider>
    </WorkspaceCacheContext.Provider>
  );
}

function ProfileAndConnectors() {
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
          ? "Connection authorized. Switch it on in an agent’s Context → Tool access."
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
      `Configured ${value.id}. Authorize it here, then switch it on for each agent.`,
    );
  }
  return (
    <main className="account-pane">
      <p className="eyebrow">Your account</p>
      <h1>Profile &amp; connectors</h1>
      <p>
        Manage shared memories and authorize accounts, then choose which tools
        each agent may use. Disconnecting here revokes access for all your
        agents.
      </p>
      <details className="user-memories">
        <summary>
          🧠 Memories <span>({profile.memories.length})</span>
        </summary>
        <p className="section-copy">
          Shared across all your agents. Useful preferences, projects and
          context are remembered selectively. Ask any agent to remember, correct
          or forget something.
        </p>
        {profile.memories.length ? (
          <div className="memory-list">
            {profile.memories.map((memory) => (
              <div className="memory-row" key={memory.key}>
                <code>{memory.key}</code>
                <span>{memory.content}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-copy">Nothing remembered yet.</p>
        )}
      </details>
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
                      `${connection.id}: ${catalog.length} tools available. Switch this connection on in an agent’s Context → Tool access.`,
                    );
                  })
                }
              >
                Test connection{tools.length ? ` (${tools.length} tools)` : ""}
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
