"use client";

import type {AgentProfile, ApprovalRequest} from "@restate-agents/types";
import {
  Activity,
  Ban,
  Check,
  CircleAlert,
  CircleCheck,
  GitBranch,
  Globe,
  MessageSquareText,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {AgentClient, SequencedEntry} from "./agent-client";
import {AgentToolsPanel} from "./agent-tools-panel";
import {errorMessage, type Notify, runAction, shortTurn} from "./format";
import {Transcript} from "./transcript";
import {useAgent} from "./use-agent";

type Mode = "ask" | "steer" | "interrupt";
type Tab = "approvals" | "profile";
type Guardrail = AgentProfile["guardrails"][number];
type Toast = {
  id: number;
  message: string;
  error: boolean;
};

const MODE_COPY: Record<Mode, {label: string; description: string}> = {
  ask: {
    label: "Ask",
    description: "Starts a turn when idle; queues behind an active turn.",
  },
  steer: {
    label: "Steer",
    description:
      "Guides the current turn after its active tool batch completes.",
  },
  interrupt: {
    label: "Interrupt",
    description: "Stops unfinished work and asks the turn for a final summary.",
  },
};

// Reconstruct the visible turn from the append-only transcript. A newly
// accepted turn or pending approval can lead the next history poll, so both
// serve as temporary hints until its events arrive.
function activeTurn(
  entries: SequencedEntry[],
  provisional?: string,
  pendingTurnId?: string,
) {
  const turns = new Map<
    string,
    {terminal: boolean; phase?: string; message?: string}
  >();
  let active = pendingTurnId ?? provisional;
  if (provisional) turns.set(provisional, {terminal: false});
  if (pendingTurnId) turns.set(pendingTurnId, {terminal: false});

  for (const {entry} of entries) {
    if (entry.role === "assistant") {
      const turnId = entry.turnId;
      const turn = turns.get(turnId) ?? {terminal: false};
      turn.terminal = true;
      if (active === turnId) active = undefined;
      turns.set(turnId, turn);
      continue;
    }
    if (entry.role !== "event" || !("turnId" in entry) || !entry.turnId) {
      continue;
    }
    const turnId = entry.turnId;
    const turn = turns.get(turnId) ?? {terminal: false};
    if (entry.type === "progress") {
      turn.phase = entry.phase;
      turn.message = entry.message;
    } else if (entry.type === "activity") {
      turn.phase = "thinking";
      turn.message = entry.message;
    } else if (entry.type === "tools") {
      turn.phase = entry.phase === "started" ? "tools" : "thinking";
      turn.message = `${entry.phase === "started" ? "Running" : "Finished"} ${entry.calls
        .map((call) => call.summary ?? call.name)
        .join(", ")}`;
    } else if (entry.type === "interrupt") {
      turn.phase = "finalizing";
      turn.message = "Finalizing the interrupted turn";
    } else if (entry.type === "stop") {
      turn.phase = "finalizing";
      turn.message = "Finalizing the stopped turn";
    }
    if (!turn.terminal) active = turnId;
    turns.set(turnId, turn);
  }

  for (const turnId of [pendingTurnId, provisional]) {
    if (turnId && !turns.get(turnId)?.terminal) {
      active = turnId;
      break;
    }
  }
  return active ? {turnId: active, ...turns.get(active)} : undefined;
}

function Toasts({toasts}: {toasts: Toast[]}) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div className="toast" data-error={toast.error} key={toast.id}>
          {toast.error ? <CircleAlert /> : <CircleCheck />}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}

function ConnectionHeader({
  name,
  connected,
  error,
}: {
  name: string;
  connected: boolean;
  error?: string;
}) {
  const connectionLabel = connected ? "Live" : error ? "Offline" : "Connecting";
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <GitBranch aria-hidden="true" />
        </div>
        <div>
          <strong>{name}</strong>
          <span>Restate Agent</span>
        </div>
      </div>
      <div className="topbar-actions">
        <span
          className="connection-status"
          data-connected={connected}
          title={error ?? connectionLabel}
        >
          <span className="connection-dot" />
          {connectionLabel}
        </span>
      </div>
    </header>
  );
}

function StatusStrip({turn}: {turn: ReturnType<typeof activeTurn>}) {
  if (!turn || turn.terminal) {
    return (
      <div className="status-strip">
        <span className="idle-dot" />
        <span>Idle</span>
        <span className="status-detail">
          The next ask starts a durable turn.
        </span>
      </div>
    );
  }
  return (
    <div className="status-strip running">
      <Sparkles className="thinking-icon" />
      <strong>{turn.phase ?? "starting"}</strong>
      <span className="status-detail shimmer">
        {turn.message ?? "Preparing the turn"}
      </span>
      <span className="status-turn">{shortTurn(turn.turnId)}</span>
    </div>
  );
}

function Composer({
  mode,
  setMode,
  onSend,
  busy,
}: {
  mode: Mode;
  setMode: (mode: Mode) => void;
  onSend: (message: string, replacement?: string) => Promise<void>;
  busy: boolean;
}) {
  const [message, setMessage] = useState("");
  const [replacement, setReplacement] = useState("");
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  async function submit() {
    const next =
      message.trim() ||
      (mode === "interrupt" ? "Interrupted by the user." : "");
    if (!next || sending) return;
    setSending(true);
    try {
      await onSend(next, replacement.trim() || undefined);
      setMessage("");
      if (mode === "interrupt") setReplacement("");
    } catch {
      // The parent reports protocol errors through the shared toast surface.
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="composer-shell">
      <div className="mode-row">
        <fieldset className="mode-switcher" aria-label="Message delivery mode">
          {(Object.keys(MODE_COPY) as Mode[]).map((candidate) => (
            <button
              data-active={mode === candidate}
              key={candidate}
              onClick={() => setMode(candidate)}
              type="button"
            >
              {candidate === "ask" ? (
                <MessageSquareText />
              ) : candidate === "steer" ? (
                <GitBranch />
              ) : (
                <Ban />
              )}
              {MODE_COPY[candidate].label}
            </button>
          ))}
        </fieldset>
        <span className="mode-description">{MODE_COPY[mode].description}</span>
      </div>
      <div className="composer-box" data-mode={mode}>
        <textarea
          aria-label={`${MODE_COPY[mode].label} message`}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            mode === "ask"
              ? "Ask the agent to do something…"
              : mode === "steer"
                ? "Guide the active turn…"
                : "Optional: explain why the active turn should stop…"
          }
          ref={textarea}
          rows={2}
          value={message}
        />
        <button
          aria-label={MODE_COPY[mode].label}
          className="send-button"
          disabled={sending || (mode === "interrupt" ? !busy : !message.trim())}
          onClick={() => void submit()}
          type="button"
        >
          {sending ? (
            <RefreshCw className="spin" />
          ) : mode === "interrupt" ? (
            <Ban />
          ) : (
            <Send />
          )}
        </button>
      </div>
      {mode === "interrupt" && (
        <input
          className="replacement-input"
          onChange={(event) => setReplacement(event.target.value)}
          placeholder="Optional replacement request for the next turn"
          value={replacement}
        />
      )}
      {busy && mode === "ask" && (
        <p className="composer-note">
          This request will be queued behind the active turn.
        </p>
      )}
    </div>
  );
}

function ApprovalsPanel({
  approvals,
  client,
  notify,
}: {
  approvals: ApprovalRequest[];
  client: AgentClient;
  notify: Notify;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState<string>();
  if (approvals.length === 0) {
    return (
      <div className="panel-empty">
        <ShieldCheck />
        <strong>No pending approvals</strong>
        <span>
          Human decisions requested by tools and guardrails appear here.
        </span>
      </div>
    );
  }
  return (
    <div className="card-list">
      {approvals.map((approval) => (
        <article className="approval-card" key={approval.approvalId}>
          <div className="card-kicker">
            <ShieldCheck />
            {approval.guardrailId
              ? `Guardrail · ${approval.guardrailId}`
              : "Agent request"}
          </div>
          <h3>{approval.question}</h3>
          <p className="card-meta">
            turn {shortTurn(approval.turnId)} · {approval.approvalId}
          </p>
          <input
            aria-label="Optional approval reason"
            onChange={(event) =>
              setReasons((current) => ({
                ...current,
                [approval.approvalId]: event.target.value,
              }))
            }
            placeholder="Optional reason for the model"
            value={reasons[approval.approvalId] ?? ""}
          />
          <div className="card-actions">
            {(["approved", "rejected"] as const).map((decision) => (
              <button
                className={`button ${decision === "approved" ? "approve" : "reject"}`}
                disabled={resolving === approval.approvalId}
                key={decision}
                onClick={async () => {
                  setResolving(approval.approvalId);
                  await runAction(notify, async () => {
                    const reason = reasons[approval.approvalId]?.trim();
                    const delivered = await client.resolveApproval({
                      approvalId: approval.approvalId,
                      decision,
                      ...(reason ? {reason} : {}),
                    });
                    return delivered
                      ? `Decision delivered: ${decision}`
                      : ["That approval is no longer eligible", true];
                  });
                  setResolving(undefined);
                }}
                type="button"
              >
                {decision === "approved" ? <Check /> : <X />}
                {decision === "approved" ? "Approve" : "Reject"}
              </button>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

function GuardrailEditor({
  guardrails,
  onChange,
}: {
  guardrails: Guardrail[];
  onChange: (guardrails: Guardrail[]) => void;
}) {
  return (
    <div className="guardrail-editor">
      {guardrails.map((guardrail, index) => (
        // Rows only append or delete in this local draft; their position is
        // stable until the complete guardrail list is saved.
        // oxlint-disable-next-line react/no-array-index-key
        <div className="guardrail-row" key={`${index}-${guardrail.id}`}>
          <input
            aria-label="Guardrail ID"
            className="guardrail-id"
            onChange={(event) => {
              const next = guardrails.slice();
              next[index] = {...guardrail, id: event.target.value};
              onChange(next);
            }}
            placeholder="id"
            value={guardrail.id}
          />
          <input
            aria-label="Guardrail policy"
            onChange={(event) => {
              const next = guardrails.slice();
              next[index] = {...guardrail, rule: event.target.value};
              onChange(next);
            }}
            placeholder="Natural-language policy…"
            value={guardrail.rule}
          />
          <button
            aria-label={`Remove guardrail ${guardrail.id || index + 1}`}
            className="icon-button danger"
            onClick={() =>
              onChange(guardrails.filter((_, row) => row !== index))
            }
            type="button"
          >
            <Trash2 />
          </button>
        </div>
      ))}
      <button
        className="button ghost small"
        onClick={() => onChange([...guardrails, {id: "", rule: ""}])}
        type="button"
      >
        <Plus /> Add guardrail
      </button>
    </div>
  );
}

function ProfilePanel({
  client,
  profile,
  notify,
  refreshProfile,
}: {
  client: AgentClient;
  profile?: AgentProfile;
  notify: Notify;
  refreshProfile: () => Promise<AgentProfile>;
}) {
  // Unedited fields follow the live profile; a draft exists only while the
  // user has unsaved changes.
  const [instructionsDraft, setInstructionsDraft] = useState<string>();
  const [guardrailsDraft, setGuardrailsDraft] = useState<Guardrail[]>();
  const [savingWebSearch, setSavingWebSearch] = useState(false);
  const instructions = instructionsDraft ?? profile?.instructions ?? "";
  const guardrails = guardrailsDraft ?? profile?.guardrails ?? [];
  const instructionsDirty = instructionsDraft !== undefined;

  return (
    <div className="settings-sections">
      <AgentToolsPanel
        client={client}
        profile={profile}
        refresh={refreshProfile}
        notify={notify}
      />
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <Globe />
            <span>
              <strong>Web search</strong>
              <small>Tavily · free keyless access</small>
            </span>
          </div>
          <button
            aria-label="Web search"
            aria-checked={profile?.webSearchEnabled ?? true}
            aria-describedby="web-search-description"
            className="web-search-toggle"
            disabled={!profile || savingWebSearch}
            onClick={async () => {
              if (!profile || savingWebSearch) return;
              const enabled = !profile.webSearchEnabled;
              setSavingWebSearch(true);
              await runAction(notify, async () => {
                await client.updateProfile({webSearchEnabled: enabled});
                await refreshProfile();
                return `Web search ${enabled ? "enabled" : "disabled"} for future turns`;
              });
              setSavingWebSearch(false);
            }}
            role="switch"
            type="button"
          >
            <span className="web-search-toggle-track" aria-hidden="true">
              <span />
            </span>
            {savingWebSearch
              ? "Saving…"
              : profile?.webSearchEnabled === false
                ? "Disabled"
                : "Enabled"}
          </button>
        </div>
        <p className="section-copy" id="web-search-description">
          Search queries are sent to Tavily. No API key needed; free access is
          rate-limited. Changes apply from the next turn.
        </p>
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <Settings2 />
            <span>
              <strong>Instructions</strong>
              <small>Agent instructions</small>
            </span>
          </div>
        </div>
        <textarea
          onChange={(event) => setInstructionsDraft(event.target.value)}
          placeholder="Prefer concise answers and metric units."
          rows={4}
          value={instructions}
        />
        <div className="inline-actions">
          <button
            className="button primary small"
            onClick={() =>
              runAction(notify, async () => {
                await client.updateProfile({
                  instructions: instructions.trim() || null,
                });
                setInstructionsDraft(undefined);
                await refreshProfile();
                return instructions.trim()
                  ? "Instructions saved"
                  : "Instructions cleared";
              })
            }
            type="button"
          >
            <Save /> Save
          </button>
          <button
            className="button ghost small"
            disabled={!instructionsDirty}
            onClick={() => setInstructionsDraft(undefined)}
            type="button"
          >
            Revert
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-heading">
          <div>
            <ShieldCheck />
            <span>
              <strong>Guardrails</strong>
              <small>Runtime policy gates</small>
            </span>
          </div>
          <button
            className="button primary small"
            onClick={async () => {
              const next = guardrails.filter(
                ({id, rule}) => id.trim() || rule.trim(),
              );
              if (next.some(({id, rule}) => !id.trim() || !rule.trim())) {
                notify("Every guardrail needs both an id and a policy", true);
                return;
              }
              await runAction(notify, async () => {
                await client.updateProfile({guardrails: next});
                setGuardrailsDraft(undefined);
                await refreshProfile();
                return next.length
                  ? `${next.length} guardrail(s) saved`
                  : "Guardrails cleared";
              });
            }}
            type="button"
          >
            <Save /> Save
          </button>
        </div>
        <p className="section-copy">
          Natural-language policies evaluated before tool batches or responses
          are published.
        </p>
        <GuardrailEditor
          guardrails={guardrails}
          onChange={setGuardrailsDraft}
        />
      </section>
    </div>
  );
}

function Inspector({
  readOnly,
  tab,
  setTab,
  approvals,
  profile,
  client,
  notify,
  refreshProfile,
}: {
  readOnly: boolean;
  tab: Tab;
  setTab: (tab: Tab) => void;
  approvals: ApprovalRequest[];
  profile?: AgentProfile;
  client: AgentClient;
  notify: Notify;
  refreshProfile: () => Promise<AgentProfile>;
}) {
  const tabs: Array<{id: Tab; label: string; icon: typeof Activity}> = [
    {id: "approvals", label: "Approvals", icon: ShieldCheck},
  ];
  if (!readOnly) tabs.push({id: "profile", label: "Context", icon: Settings2});
  return (
    <aside className="inspector">
      <div className="inspector-tabs" role="tablist">
        {tabs.map(({id, label, icon: Icon}) => (
          <button
            aria-selected={tab === id}
            data-active={tab === id}
            key={id}
            onClick={() => setTab(id)}
            role="tab"
            type="button"
          >
            <Icon /> {label}
            {id === "approvals" && approvals.length > 0 && (
              <span>{approvals.length}</span>
            )}
          </button>
        ))}
      </div>
      <div className="inspector-content" role="tabpanel">
        {tab === "approvals" && (
          <ApprovalsPanel
            approvals={approvals}
            client={client}
            notify={notify}
          />
        )}
        {tab === "profile" && !readOnly && (
          <ProfilePanel
            client={client}
            notify={notify}
            profile={profile}
            refreshProfile={refreshProfile}
          />
        )}
      </div>
    </aside>
  );
}

export function App({initialAgentId}: {initialAgentId: string}) {
  const [mode, setMode] = useState<Mode>("ask");
  const [tab, setTab] = useState<Tab>("approvals");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [provisionalTurn, setProvisionalTurn] = useState<string>();
  const toastId = useRef(0);
  const agent = useAgent(initialAgentId);
  const agentName = agent.metadata?.name ?? initialAgentId;
  const readOnly = Boolean(agent.metadata?.parentAgentId);
  const pendingTurnId = agent.approvals[0]?.turnId;
  const turn = useMemo(
    () => activeTurn(agent.entries, provisionalTurn, pendingTurnId),
    [agent.entries, pendingTurnId, provisionalTurn],
  );
  // A just-started turn is shown before its first entry arrives; forget it
  // once it is no longer active. Adjusted during render, not in an effect.
  if (provisionalTurn && !turn) setProvisionalTurn(undefined);
  const notify = useCallback((message: string, error = false) => {
    const id = ++toastId.current;
    setToasts((current) => [...current, {id, message, error}]);
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      error ? 6_000 : 3_200,
    );
  }, []);

  useEffect(() => {
    document.title = `Restate Agent · ${initialAgentId}`;
  }, [initialAgentId]);

  async function sendMessage(message: string, replacement?: string) {
    try {
      if (mode === "ask") {
        const result = await agent.client.ask(message);
        if (result.decision === "start") {
          setProvisionalTurn(result.turnId);
          notify(`Turn started: ${shortTurn(result.turnId)}`);
        } else {
          notify(
            `Queued (${result.stats.pendingMessages} pending) behind ${shortTurn(result.activeTurnId)}`,
          );
        }
      } else if (mode === "steer") {
        const accepted = await agent.client.steer(message);
        notify(
          accepted
            ? "Steering delivered to the active turn"
            : "No turn is accepting steering",
          !accepted,
        );
      } else {
        const accepted = await agent.client.interrupt(message, replacement);
        notify(
          accepted ? "Interruption requested" : "Nothing to interrupt",
          !accepted,
        );
      }
    } catch (error) {
      notify(errorMessage(error), true);
      throw error;
    }
  }

  return (
    <div className="app-shell">
      <ConnectionHeader
        connected={agent.connected}
        name={agentName}
        error={agent.connectionError}
      />
      <nav className="demo-navigation" aria-label="Agent navigation">
        <form action="/" method="get">
          <label htmlFor="agent-id">Agent ID</label>
          <input
            id="agent-id"
            name="agent"
            defaultValue={initialAgentId}
            maxLength={256}
            required
          />
          <button type="submit" className="button secondary">
            Open agent
          </button>
        </form>
        {agent.metadata?.parentAgentId && (
          <a
            href={`/?agent=${encodeURIComponent(agent.metadata.parentAgentId)}`}
          >
            Parent conversation
          </a>
        )}
        {agent.children.map((child) => (
          <a
            key={child.agentId}
            href={`/?agent=${encodeURIComponent(child.agentId)}`}
          >
            {child.name}
          </a>
        ))}
      </nav>
      <main className="workspace" data-readonly={readOnly}>
        <section className="conversation-pane">
          <div className="conversation-heading">
            <div>
              <p className="eyebrow">Conversation</p>
              <h1>{agentName}</h1>
            </div>
            <div className="conversation-stat">
              <Activity />
              <span>{agent.entries.length} durable events</span>
            </div>
          </div>
          <div className="transcript-frame">
            <Transcript
              entries={agent.entries}
              busy={Boolean(turn && !turn.terminal)}
            />
          </div>
          <StatusStrip turn={turn} />
          {readOnly ? (
            <div className="composer-shell">
              <p className="empty-copy">
                Sub-agent conversation — only its parent can send tasks and
                follow-ups.
              </p>
              <button
                type="button"
                className="button secondary"
                disabled={!turn || turn.terminal}
                onClick={() =>
                  runAction(notify, async () =>
                    (await agent.client.interrupt("Interrupted by the user"))
                      ? "Interruption requested"
                      : "Nothing to interrupt",
                  )
                }
              >
                <Ban /> Interrupt
              </button>
              {agent.approvals.length > 0 && (
                <p className="empty-copy">
                  This child is waiting for approval. Use the Approvals panel to
                  respond, or interrupt its task.
                </p>
              )}
            </div>
          ) : (
            <Composer
              busy={Boolean(turn && !turn.terminal)}
              mode={mode}
              onSend={sendMessage}
              setMode={setMode}
            />
          )}
        </section>
        <Inspector
          readOnly={readOnly}
          approvals={agent.approvals}
          client={agent.client}
          notify={notify}
          profile={agent.profile}
          refreshProfile={agent.refreshProfile}
          setTab={setTab}
          tab={tab}
        />
      </main>
      <details className="demo-state">
        <summary>Memories and schedules</summary>
        <h3>Agent memories</h3>
        {!agent.profile?.memories.length && (
          <p>
            No saved memories. Ask this agent to remember something for a later
            turn.
          </p>
        )}
        {agent.profile?.memories.map((entry) => (
          <p key={entry.key}>
            <strong>{entry.key}</strong>: {entry.content}
            {!readOnly && (
              <button
                type="button"
                onClick={() =>
                  runAction(notify, async () => {
                    await agent.client.deleteMemory(entry.key);
                  })
                }
              >
                Delete
              </button>
            )}
          </p>
        ))}
        <h3>Scheduled messages</h3>
        {!agent.schedules.length && (
          <p>No scheduled messages. Ask this agent to schedule a reminder.</p>
        )}
        {agent.schedules.map((schedule) => (
          <p key={schedule.scheduleId}>
            <strong>{schedule.scheduleId}</strong>: {schedule.message} ·{" "}
            {new Date(schedule.nextRunAt).toLocaleString()}
            {!readOnly && (
              <button
                type="button"
                onClick={() =>
                  runAction(notify, async () => {
                    await agent.client.cancelSchedule(schedule.scheduleId);
                  })
                }
              >
                Cancel
              </button>
            )}
          </p>
        ))}
      </details>
      <Toasts toasts={toasts} />
    </div>
  );
}
