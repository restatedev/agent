"use client";

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
import {Transcript} from "./transcript";
import {
  type AgentConnection,
  type AgentProfile,
  type ApprovalRequest,
  useAgent,
} from "./use-agent";

type Mode = "ask" | "steer" | "interrupt";
type Tab = "approvals" | "profile";
type Guardrail = AgentProfile["guardrails"][number];
type TurnTerminalStatus = Extract<
  SequencedEntry["entry"],
  {role: "assistant"}
>["status"];
type AgentMarkState =
  | "offline"
  | "connecting"
  | "idle"
  | "thinking"
  | "working"
  | "waiting"
  | "finalizing"
  | "done"
  | "interrupted"
  | "stopped"
  | "failed";

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

function shortTurn(turnId: string) {
  return turnId.length > 14 ? `${turnId.slice(0, 14)}…` : turnId;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

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

function latestTurnOutcome(
  entries: SequencedEntry[],
): TurnTerminalStatus | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]?.entry;
    if (entry?.role === "assistant") return entry.status;
    if (entry?.role === "user") return undefined;
  }
  return undefined;
}

function deriveAgentMarkState({
  connectionStatus,
  hasPendingInput,
  terminalStatus,
  turn,
}: {
  connectionStatus: "connecting" | "connected" | "failed";
  hasPendingInput: boolean;
  terminalStatus?: TurnTerminalStatus;
  turn: ReturnType<typeof activeTurn>;
}): AgentMarkState {
  if (connectionStatus === "connecting") return "connecting";
  if (connectionStatus === "failed") return "offline";
  if (turn?.phase === "finalizing") return "finalizing";
  if (turn?.phase === "waiting" || hasPendingInput) return "waiting";
  if (turn?.phase === "tools") return "working";
  if (turn) return "thinking";
  if (terminalStatus === "completed") return "done";
  if (terminalStatus === "interrupted") return "interrupted";
  if (terminalStatus === "stopped") return "stopped";
  if (terminalStatus === "failed") return "failed";
  return "idle";
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

function RestateMark({state}: {state: AgentMarkState}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const size = 36;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * pixelRatio;
    canvas.height = size * pixelRatio;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    const palettes: Record<
      AgentMarkState,
      {base: string; glow: string; accent: string; speed: number}
    > = {
      offline: {
        base: "#303640",
        glow: "#626b78",
        accent: "#8a93a1",
        speed: 0.15,
      },
      connecting: {
        base: "#2537ba",
        glow: "#755ff0",
        accent: "#6ee7ff",
        speed: 1.8,
      },
      idle: {
        base: "#303dcc",
        glow: "#b268f2",
        accent: "#67d2ff",
        speed: 0.55,
      },
      thinking: {
        base: "#432ecf",
        glow: "#cb78ff",
        accent: "#65c9ff",
        speed: 1.35,
      },
      working: {
        base: "#1558b0",
        glow: "#33d4e7",
        accent: "#7790ff",
        speed: 2.2,
      },
      waiting: {
        base: "#68431d",
        glow: "#ff9b63",
        accent: "#ffe29a",
        speed: 0.28,
      },
      finalizing: {
        base: "#5b31c9",
        glow: "#df60e2",
        accent: "#8096ff",
        speed: 1.7,
      },
      done: {
        base: "#16704b",
        glow: "#57e397",
        accent: "#a7ffd0",
        speed: 0.75,
      },
      interrupted: {
        base: "#6c3c18",
        glow: "#e8893f",
        accent: "#ffd39a",
        speed: 0.5,
      },
      stopped: {
        base: "#3d4350",
        glow: "#7b8494",
        accent: "#c3cad5",
        speed: 0.32,
      },
      failed: {
        base: "#6c2731",
        glow: "#d85468",
        accent: "#ffc1ca",
        speed: 0.58,
      },
    };
    const chevronOne = new Path2D(
      "M6.248 7.691A1.43 1.43 0 0 0 6 8.498v8.16c0 .277.313.439.539.278l.824-.585c.228-.162.363-.424.363-.703V9.976c0-.338.381-.536.658-.341l3.245 2.286a.274.274 0 0 1-.004.453l-1.088.737a.866.866 0 0 0-.219 1.207.855.855 0 0 0 1.19.209l1.779-1.234c.381-.264.608-.699.608-1.163 0-.454-.219-.882-.588-1.147L8.039 7.184a1.297 1.297 0 0 0-1.695.366l-.096.141Z",
    );
    const chevronTwo = new Path2D(
      "M11.737 7.368a.86.86 0 0 0 .2 1.199l4.432 3.191a.416.416 0 0 1 .011.669l-3.671 2.836a.857.857 0 0 0-.169 1.195.87.87 0 0 0 1.224.175l4.381-3.356c.37-.283.586-.723.586-1.188 0-.482-.232-.935-.623-1.216l-5.162-3.708a.86.86 0 0 0-1.209.203Z",
    );
    let animationFrame = 0;
    let disposed = false;
    let lastFrameAt = window.performance.now();

    const draw = (time: number) => {
      if (disposed) return;
      lastFrameAt = window.performance.now();
      const currentState = state;
      const palette = palettes[currentState];
      const seconds = time / 1_000;
      const phase = seconds * palette.speed;
      context.clearRect(0, 0, size, size);

      const background = context.createLinearGradient(2, 2, 34, 34);
      background.addColorStop(0, palette.base);
      background.addColorStop(0.58, palette.glow);
      background.addColorStop(1, palette.base);
      context.fillStyle = background;
      context.fillRect(0, 0, size, size);

      context.save();
      // Radial gradients already provide the blur. Avoid context.filter here:
      // it takes a fragile accelerated-canvas path in Safari.
      context.globalCompositeOperation = "lighter";
      for (let index = 0; index < 3; index += 1) {
        const angle = phase + index * ((Math.PI * 2) / 3);
        const orbit = currentState === "waiting" ? 5 : 8;
        const x = 18 + Math.cos(angle) * orbit;
        const y = 18 + Math.sin(angle * 1.17) * orbit;
        const radius = 7 + Math.sin(phase * 1.4 + index) * 2;
        const glow = context.createRadialGradient(x, y, 0, x, y, radius);
        glow.addColorStop(0, index === 1 ? palette.accent : palette.glow);
        glow.addColorStop(1, "transparent");
        context.globalAlpha = currentState === "offline" ? 0.18 : 0.62;
        context.fillStyle = glow;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();

      if (
        currentState === "connecting" ||
        currentState === "thinking" ||
        currentState === "finalizing"
      ) {
        context.save();
        context.translate(18, 18);
        context.rotate(phase * 1.5);
        context.strokeStyle = palette.accent;
        context.globalAlpha = 0.48;
        context.lineWidth = 1;
        context.setLineDash([2.5, 3.5]);
        context.beginPath();
        context.arc(0, 0, 13, 0, Math.PI * 2);
        context.stroke();
        context.restore();
      }

      if (currentState === "working") {
        context.save();
        context.strokeStyle = palette.accent;
        context.lineWidth = 1.2;
        for (let index = 0; index < 4; index += 1) {
          const offset = ((seconds * 28 + index * 10) % 50) - 12;
          context.globalAlpha = 0.2 + index * 0.11;
          context.beginPath();
          context.moveTo(offset - 8, 36);
          context.lineTo(offset + 10, 0);
          context.stroke();
        }
        context.restore();
      }

      if (
        currentState === "done" ||
        currentState === "interrupted" ||
        currentState === "failed"
      ) {
        const progress = (seconds % 2.4) / 2.4;
        context.save();
        context.strokeStyle = palette.accent;
        context.globalAlpha = Math.max(0, 0.62 - progress);
        context.lineWidth = 1.2;
        context.beginPath();
        context.arc(18, 18, 7 + progress * 10, 0, Math.PI * 2);
        context.stroke();
        context.restore();
      }

      const logoShift =
        currentState === "connecting" ||
        currentState === "thinking" ||
        currentState === "working"
          ? Math.sin(phase * 4) * 0.7
          : 0;
      context.save();
      context.translate(3 + logoShift, 3);
      context.scale(1.25, 1.25);
      const logoGradient = context.createLinearGradient(6, 7, 19, 17);
      logoGradient.addColorStop(0, "#ffffff");
      logoGradient.addColorStop(0.52, "#e1ddff");
      logoGradient.addColorStop(1, "#b5e5ff");
      context.fillStyle = logoGradient;
      context.shadowColor = "rgba(24, 19, 82, 0.58)";
      context.shadowBlur = 2.5;
      context.shadowOffsetY = 1;
      context.fill(chevronOne);
      context.fill(chevronTwo);
      context.restore();

      context.fillStyle = palette.accent;
      context.strokeStyle = "rgba(17, 20, 25, 0.72)";
      context.lineWidth = 1;
      context.beginPath();
      context.arc(31, 31, 2.3, 0, Math.PI * 2);
      context.fill();
      context.stroke();

      if (!document.hidden) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    const restart = () => {
      if (disposed || document.hidden) return;
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(draw);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        window.cancelAnimationFrame(animationFrame);
      } else {
        restart();
      }
    };
    const watchdog = window.setInterval(() => {
      if (
        !disposed &&
        !document.hidden &&
        window.performance.now() - lastFrameAt > 1_500
      ) {
        restart();
      }
    }, 2_000);

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", restart);
    window.addEventListener("pageshow", restart);
    restart();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      window.clearInterval(watchdog);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", restart);
      window.removeEventListener("pageshow", restart);
    };
  }, [state]);

  return (
    <canvas
      className="restate-mark-canvas"
      ref={canvasRef}
      style={{
        borderRadius: 9,
        display: "block",
        height: "100%",
        position: "static",
        width: "100%",
      }}
    />
  );
}

function ConnectionHeader({
  activity,
  name,
  connected,
  error,
}: {
  activity: AgentMarkState;
  name: string;
  connected: boolean;
  error?: string;
}) {
  const connectionLabel = connected ? "Live" : error ? "Offline" : "Connecting";
  return (
    <header className="topbar">
      <div className="brand">
        <div
          className="brand-mark"
          data-state={activity}
          key={activity}
          title={`Agent status: ${activity}`}
        >
          <RestateMark state={activity} />
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
  notify: (message: string, error?: boolean) => void;
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
                  try {
                    const reason = reasons[approval.approvalId]?.trim();
                    const delivered = await client.resolveApproval({
                      approvalId: approval.approvalId,
                      decision,
                      ...(reason ? {reason} : {}),
                    });
                    notify(
                      delivered
                        ? `Decision delivered: ${decision}`
                        : "That approval is no longer eligible",
                      !delivered,
                    );
                  } catch (error) {
                    notify(errorMessage(error), true);
                  } finally {
                    setResolving(undefined);
                  }
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
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
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
  notify: (message: string, error?: boolean) => void;
  refreshProfile: () => Promise<AgentProfile>;
}) {
  const [instructions, setInstructions] = useState("");
  const [guardrails, setGuardrails] = useState<Guardrail[]>([]);
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [guardrailsDirty, setGuardrailsDirty] = useState(false);
  const [savingWebSearch, setSavingWebSearch] = useState(false);
  useEffect(() => {
    if (!profile) return;
    if (!instructionsDirty) setInstructions(profile.instructions ?? "");
    if (!guardrailsDirty) setGuardrails(profile.guardrails);
  }, [guardrailsDirty, instructionsDirty, profile]);

  const changeGuardrails = (next: Guardrail[]) => {
    setGuardrails(next);
    setGuardrailsDirty(true);
  };

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
              try {
                await client.setWebSearchEnabled(enabled);
                await refreshProfile();
                notify(
                  `Web search ${enabled ? "enabled" : "disabled"} for future turns`,
                );
              } catch (error) {
                notify(errorMessage(error), true);
              } finally {
                setSavingWebSearch(false);
              }
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
          onChange={(event) => {
            setInstructions(event.target.value);
            setInstructionsDirty(true);
          }}
          placeholder="Prefer concise answers and metric units."
          rows={4}
          value={instructions}
        />
        <div className="inline-actions">
          <button
            className="button primary small"
            onClick={async () => {
              try {
                await client.setInstructions(instructions.trim() || null);
                setInstructionsDirty(false);
                notify(
                  instructions.trim()
                    ? "Instructions saved"
                    : "Instructions cleared",
                );
                await refreshProfile();
              } catch (error) {
                notify(errorMessage(error), true);
              }
            }}
            type="button"
          >
            <Save /> Save
          </button>
          <button
            className="button ghost small"
            disabled={!instructionsDirty}
            onClick={() => {
              setInstructions(profile?.instructions ?? "");
              setInstructionsDirty(false);
            }}
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
              try {
                await client.setGuardrails(next);
                setGuardrails(next);
                setGuardrailsDirty(false);
                notify(
                  next.length
                    ? `${next.length} guardrail(s) saved`
                    : "Guardrails cleared",
                );
                await refreshProfile();
              } catch (error) {
                notify(errorMessage(error), true);
              }
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
        <GuardrailEditor guardrails={guardrails} onChange={changeGuardrails} />
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
  notify: (message: string, error?: boolean) => void;
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
  const [connection] = useState<AgentConnection>({
    agentId: initialAgentId,
  });
  const [mode, setMode] = useState<Mode>("ask");
  const [tab, setTab] = useState<Tab>("approvals");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [provisionalTurn, setProvisionalTurn] = useState<string>();
  const toastId = useRef(0);
  const agent = useAgent(connection);
  const agentName = agent.metadata?.name ?? connection.agentId;
  const readOnly = Boolean(agent.metadata?.parentAgentId);
  const pendingTurnId = agent.approvals[0]?.turnId;
  const turn = useMemo(
    () => activeTurn(agent.entries, provisionalTurn, pendingTurnId),
    [agent.entries, pendingTurnId, provisionalTurn],
  );
  const terminalStatus = useMemo(
    () => latestTurnOutcome(agent.entries),
    [agent.entries],
  );
  const notify = useCallback((message: string, error = false) => {
    const id = ++toastId.current;
    setToasts((current) => [...current, {id, message, error}]);
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      error ? 6_000 : 3_200,
    );
  }, []);

  useEffect(() => {
    if (!turn) setProvisionalTurn(undefined);
  }, [turn]);
  useEffect(() => {
    document.title = `Restate Agent · ${connection.agentId}`;
  }, [connection.agentId]);

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

  const markState = deriveAgentMarkState({
    connectionStatus: agent.connectionStatus,
    hasPendingInput: agent.approvals.length > 0,
    terminalStatus,
    turn,
  });

  return (
    <div className="app-shell">
      <ConnectionHeader
        activity={markState}
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
            defaultValue={connection.agentId}
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
                onClick={async () => {
                  try {
                    const accepted = await agent.client.interrupt(
                      "Interrupted by the user",
                    );
                    notify(
                      accepted
                        ? "Interruption requested"
                        : "Nothing to interrupt",
                    );
                  } catch (error) {
                    notify(errorMessage(error), true);
                  }
                }}
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
        {
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
        }
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
                onClick={() => {
                  void agent.client
                    .deleteMemory(entry.key)
                    .catch((error) => notify(errorMessage(error), true));
                }}
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
                onClick={() => {
                  void agent.client
                    .cancelSchedule(schedule.scheduleId)
                    .catch((error) => notify(errorMessage(error), true));
                }}
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
