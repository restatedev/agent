"use client";

import {
  Activity,
  AlarmClock,
  Ban,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FlaskConical,
  GitBranch,
  Globe,
  KeyRound,
  MemoryStick,
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
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentClient,
  ScheduleSpecInput,
  SequencedEntry,
} from "./agent-client";
import {AgentToolsPanel} from "./agent-tools-panel";
import {Transcript} from "./transcript";
import {
  type AgentConnection,
  type AgentProfile,
  type ApprovalRequest,
  type McpAuthorizationRequest,
  type ScheduledMessage,
  useAgent,
} from "./use-agent";

type Mode = "ask" | "steer" | "interrupt";
type Tab = "approvals" | "profile" | "evals";
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

type EvalAssertion = {
  name: string;
  passed: boolean;
  details?: string;
};

type EvalResult = {
  caseId: string;
  status: "passed" | "failed";
  assertions: EvalAssertion[];
};

type EvalSuite = {
  status: "passed" | "failed";
  results: EvalResult[];
};

const EVAL_CASES = [
  "basic-turn",
  "steering",
  "interruption",
  "external-cancellation",
  "interruption-replacement",
  "memory",
  "scheduling",
  "guardrail-approval",
  "guardrail-scope",
  "guardrail-denial",
  "guardrail-rejection",
  "guardrail-removal",
  "guardrail-steering",
] as const;

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

function formatDuration(totalSeconds: number) {
  const units: Array<[number, string]> = [
    [86_400, "d"],
    [3_600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  const parts: string[] = [];
  let rest = Math.max(0, Math.round(totalSeconds));
  for (const [size, label] of units) {
    if (rest >= size && parts.length < 2) {
      parts.push(`${Math.floor(rest / size)}${label}`);
      rest %= size;
    }
  }
  return parts.length ? parts.join(" ") : "0s";
}

function nextRunLabel(epochMs: number) {
  const deltaMs = epochMs - Date.now();
  return deltaMs <= 0 ? "due now" : `in ${formatDuration(deltaMs / 1_000)}`;
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

function McpAuthorizationCard({
  authorization,
  client,
  notify,
}: {
  authorization: McpAuthorizationRequest;
  client: AgentClient;
  notify: (message: string, error?: boolean) => void;
}) {
  const [bearerToken, setBearerToken] = useState("");
  const [resolving, setResolving] = useState(false);
  const heading =
    authorization.reason === "missing_credentials"
      ? `Connect ${authorization.serverId}`
      : authorization.reason === "insufficient_scope"
        ? `Expand access to ${authorization.serverId}`
        : `Reconnect ${authorization.serverId}`;
  const reason =
    authorization.reason === "missing_credentials"
      ? "A credential is required before this server can expose its tools."
      : authorization.reason === "insufficient_scope"
        ? "The current credential does not grant the access this tool needs."
        : "The server rejected the previous credential. Check it and try again.";

  return (
    <article className="approval-card mcp-authorization-card">
      <div className="card-kicker">
        <KeyRound /> MCP authorization
      </div>
      <h3>{heading}</h3>
      <p className="card-meta">
        turn {shortTurn(authorization.turnId)} · {authorization.authType} ·{" "}
        {authorization.reason}
        {authorization.requestedScope
          ? ` · scope ${authorization.requestedScope}`
          : ""}
      </p>
      <p>{reason}</p>
      {authorization.authType === "bearer" ? (
        <form
          className="mcp-bearer-form"
          onSubmit={async (event: FormEvent) => {
            event.preventDefault();
            const accessToken = bearerToken
              .trim()
              .replace(/^Authorization\s*:\s*/i, "")
              .replace(/^(?:Bearer\s+)+/i, "")
              .trim();
            if (!accessToken) return;
            setResolving(true);
            try {
              const completed = await client.completeMcpBearerAuthorization(
                authorization.authRequestId,
                accessToken,
              );
              if (!completed) {
                notify(
                  "The waiting turn no longer accepts this credential",
                  true,
                );
                return;
              }
              setBearerToken("");
              notify(`Credential submitted for ${authorization.serverId}`);
            } catch (error) {
              notify(errorMessage(error), true);
            } finally {
              setResolving(false);
            }
          }}
        >
          <input
            aria-label={`${authorization.serverId} bearer token`}
            autoComplete="off"
            onChange={(event) => setBearerToken(event.target.value)}
            placeholder={
              authorization.serverId === "github"
                ? "GitHub personal access token"
                : "Bearer access token"
            }
            spellCheck={false}
            type="password"
            value={bearerToken}
          />
          {authorization.serverId === "github" ? (
            <p className="field-hint">
              Paste the token itself. A leading “Bearer” is accepted and removed
              automatically.
            </p>
          ) : null}
          <div className="card-actions">
            <button
              className="button approve"
              disabled={resolving || !bearerToken.trim()}
              type="submit"
            >
              {resolving ? <RefreshCw className="spin" /> : <KeyRound />}
              Save token
            </button>
          </div>
        </form>
      ) : (
        <div className="card-actions">
          <button
            className="button approve"
            disabled={resolving}
            onClick={async () => {
              setResolving(true);
              try {
                const result = await client.startMcpAuthorization(
                  authorization.authRequestId,
                );
                if (result.status === "redirect") {
                  window.location.assign(result.authorizationUrl);
                  return;
                }
                notify(`Authorization completed for ${authorization.serverId}`);
              } catch (error) {
                notify(errorMessage(error), true);
              } finally {
                setResolving(false);
              }
            }}
            type="button"
          >
            {resolving ? <RefreshCw className="spin" /> : <KeyRound />}
            Authorize
          </button>
        </div>
      )}
    </article>
  );
}

function ApprovalsPanel({
  approvals,
  mcpAuthorizations,
  client,
  notify,
}: {
  approvals: ApprovalRequest[];
  mcpAuthorizations: McpAuthorizationRequest[];
  client: AgentClient;
  notify: (message: string, error?: boolean) => void;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState<string>();
  if (approvals.length === 0 && mcpAuthorizations.length === 0) {
    return (
      <div className="panel-empty">
        <ShieldCheck />
        <strong>No pending approvals</strong>
        <span>
          Human decisions and account connections requested by tools appear
          here.
        </span>
      </div>
    );
  }
  return (
    <div className="card-list">
      {mcpAuthorizations.map((authorization) => (
        <McpAuthorizationCard
          authorization={authorization}
          client={client}
          key={`mcp-${authorization.authRequestId}`}
          notify={notify}
        />
      ))}
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

function ScheduleList({
  schedules,
  client,
  notify,
  refresh,
}: {
  schedules: ScheduledMessage[];
  client: AgentClient;
  notify: (message: string, error?: boolean) => void;
  refresh: () => Promise<unknown>;
}) {
  if (schedules.length === 0) {
    return <p className="empty-copy">No durable schedules.</p>;
  }
  return (
    <div className="schedule-list">
      {[...schedules]
        .sort((left, right) => left.nextRunAt - right.nextRunAt)
        .map((schedule) => (
          <article className="compact-card" key={schedule.scheduleId}>
            <div>
              <strong>{schedule.message}</strong>
              <span>
                {schedule.scheduleId} · {nextRunLabel(schedule.nextRunAt)} ·{" "}
                {schedule.whenBusy}
                {schedule.repeatEverySeconds
                  ? ` · every ${formatDuration(schedule.repeatEverySeconds)}`
                  : " · once"}
              </span>
            </div>
            <button
              aria-label={`Cancel ${schedule.scheduleId}`}
              className="icon-button danger"
              onClick={async () => {
                try {
                  const result = await client.cancelSchedule(
                    schedule.scheduleId,
                  );
                  notify(
                    result.accepted
                      ? result.cancelled
                        ? `Cancelled ${schedule.scheduleId}`
                        : "Schedule was already gone"
                      : result.error,
                    !result.accepted,
                  );
                  await refresh();
                } catch (error) {
                  notify(errorMessage(error), true);
                }
              }}
              type="button"
            >
              <Trash2 />
            </button>
          </article>
        ))}
    </div>
  );
}

function ProfilePanel({
  client,
  profile,
  schedules,
  notify,
  refreshProfile,
  refreshSchedules,
}: {
  client: AgentClient;
  profile?: AgentProfile;
  schedules: ScheduledMessage[];
  notify: (message: string, error?: boolean) => void;
  refreshProfile: () => Promise<AgentProfile>;
  refreshSchedules: () => Promise<unknown>;
}) {
  const [instructions, setInstructions] = useState("");
  const [guardrails, setGuardrails] = useState<Guardrail[]>([]);
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [guardrailsDirty, setGuardrailsDirty] = useState(false);
  const [savingWebSearch, setSavingWebSearch] = useState(false);
  const [schedule, setSchedule] = useState({
    scheduleId: "",
    message: "",
    delaySeconds: "",
    repeatEverySeconds: "",
    whenBusy: "queue" as ScheduleSpecInput["whenBusy"],
  });

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
              <small>User-owned prompt context</small>
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

      <section className="settings-section">
        <div className="section-heading">
          <div>
            <MemoryStick />
            <span>
              <strong>Memories</strong>
              <small>Model-managed agent context</small>
            </span>
          </div>
        </div>
        {profile?.memories.length ? (
          <div className="memory-list">
            {profile.memories.map((memory) => (
              <div className="memory-row" key={memory.key}>
                <code>{memory.key}</code>
                <span>{memory.content}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-copy">No memories stored by the model.</p>
        )}
      </section>

      <AgentToolsPanel
        client={client}
        profile={profile}
        refresh={refreshProfile}
        notify={notify}
      />

      <section className="settings-section">
        <div className="section-heading">
          <div>
            <AlarmClock />
            <span>
              <strong>Schedules</strong>
              <small>Durable message delivery</small>
            </span>
          </div>
        </div>
        <ScheduleList
          client={client}
          notify={notify}
          refresh={refreshSchedules}
          schedules={schedules}
        />
        <form
          className="schedule-form"
          onSubmit={async (event: FormEvent) => {
            event.preventDefault();
            const delaySeconds = Number.parseInt(schedule.delaySeconds, 10);
            const repeatEverySeconds = schedule.repeatEverySeconds
              ? Number.parseInt(schedule.repeatEverySeconds, 10)
              : null;
            if (
              !schedule.scheduleId.trim() ||
              !schedule.message.trim() ||
              delaySeconds < 1
            ) {
              notify(
                "Schedule id, message, and positive delay are required",
                true,
              );
              return;
            }
            try {
              const result = await client.scheduleMessage({
                scheduleId: schedule.scheduleId.trim(),
                message: schedule.message.trim(),
                delaySeconds,
                repeatEverySeconds,
                whenBusy: schedule.whenBusy,
              });
              if (!result.accepted) {
                notify(result.error, true);
                return;
              }
              notify(
                result.replaced
                  ? `Replaced ${result.schedule.scheduleId}`
                  : `Scheduled ${result.schedule.scheduleId}`,
              );
              setSchedule({
                scheduleId: "",
                message: "",
                delaySeconds: "",
                repeatEverySeconds: "",
                whenBusy: "queue",
              });
              await refreshSchedules();
            } catch (error) {
              notify(errorMessage(error), true);
            }
          }}
        >
          <div className="form-grid two">
            <input
              onChange={(event) =>
                setSchedule({...schedule, scheduleId: event.target.value})
              }
              placeholder="Schedule id"
              value={schedule.scheduleId}
            />
            <select
              aria-label="Behavior when agent is busy"
              onChange={(event) =>
                setSchedule({
                  ...schedule,
                  whenBusy: event.target.value as ScheduleSpecInput["whenBusy"],
                })
              }
              value={schedule.whenBusy}
            >
              <option value="queue">Queue when busy</option>
              <option value="steer">Steer when busy</option>
              <option value="interrupt">Interrupt when busy</option>
            </select>
          </div>
          <input
            onChange={(event) =>
              setSchedule({...schedule, message: event.target.value})
            }
            placeholder="Message to deliver"
            value={schedule.message}
          />
          <div className="form-grid two">
            <input
              min="1"
              onChange={(event) =>
                setSchedule({...schedule, delaySeconds: event.target.value})
              }
              placeholder="Delay seconds"
              type="number"
              value={schedule.delaySeconds}
            />
            <input
              min="1"
              onChange={(event) =>
                setSchedule({
                  ...schedule,
                  repeatEverySeconds: event.target.value,
                })
              }
              placeholder="Repeat seconds (optional)"
              type="number"
              value={schedule.repeatEverySeconds}
            />
          </div>
          <button className="button secondary small" type="submit">
            <AlarmClock /> Create schedule
          </button>
        </form>
      </section>
    </div>
  );
}

function EvalsPanel({
  notify,
}: {
  notify: (message: string, error?: boolean) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(EVAL_CASES));
  const [timeout, setTimeoutValue] = useState(300);
  const [running, setRunning] = useState(false);
  const [suite, setSuite] = useState<EvalSuite>();

  async function run() {
    if (selected.size === 0) {
      notify("Select at least one eval case", true);
      return;
    }
    setRunning(true);
    setSuite(undefined);
    try {
      const response = await fetch("/api/evals", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
          runId: "demo-ui",
          timeoutSeconds: timeout,
          ...(selected.size === EVAL_CASES.length
            ? {}
            : {cases: [...selected]}),
        }),
      });
      const text = await response.text();
      const data = text
        ? (JSON.parse(text) as EvalSuite | {message?: string})
        : undefined;
      if (!response.ok) {
        throw new Error(
          (data && "message" in data && data.message) ||
            `${response.status} ${response.statusText}`,
        );
      }
      setSuite(data as EvalSuite);
    } catch (error) {
      notify(`Eval run failed: ${errorMessage(error)}`, true);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="eval-panel">
      <div className="eval-intro">
        <FlaskConical />
        <div>
          <strong>Durable protocol evals</strong>
          <span>
            Each case drives a fresh Agent through public handlers and checks
            its transcript.
          </span>
        </div>
      </div>
      <div className="eval-cases">
        {EVAL_CASES.map((caseId) => (
          <label key={caseId}>
            <input
              checked={selected.has(caseId)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(caseId);
                else next.delete(caseId);
                setSelected(next);
              }}
              type="checkbox"
            />
            <code>{caseId}</code>
          </label>
        ))}
      </div>
      <div className="eval-actions">
        <button
          className="button primary"
          disabled={running}
          onClick={() => void run()}
          type="button"
        >
          {running ? <RefreshCw className="spin" /> : <FlaskConical />}
          {running
            ? `Running ${selected.size}…`
            : `Run ${selected.size} selected`}
        </button>
        <label>
          Timeout
          <input
            min="10"
            max="600"
            onChange={(event) => setTimeoutValue(Number(event.target.value))}
            type="number"
            value={timeout}
          />
          s
        </label>
      </div>
      {suite && (
        <div className="eval-results" data-status={suite.status}>
          <div className="suite-status">
            {suite.status === "passed" ? <CircleCheck /> : <CircleAlert />}
            Suite {suite.status}
          </div>
          {suite.results.map((result) => (
            <details key={result.caseId} open={result.status === "failed"}>
              <summary>
                {result.status === "passed" ? <Check /> : <X />}
                <code>{result.caseId}</code>
                <ChevronRight />
              </summary>
              <ul>
                {result.assertions.map((assertion) => (
                  <li data-passed={assertion.passed} key={assertion.name}>
                    {assertion.passed ? <Check /> : <X />}
                    <span>
                      {assertion.name}
                      {assertion.details ? ` · ${assertion.details}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function Inspector({
  tab,
  setTab,
  approvals,
  mcpAuthorizations,
  profile,
  schedules,
  client,
  notify,
  refreshProfile,
  refreshSchedules,
}: {
  tab: Tab;
  setTab: (tab: Tab) => void;
  approvals: ApprovalRequest[];
  mcpAuthorizations: McpAuthorizationRequest[];
  profile?: AgentProfile;
  schedules: ScheduledMessage[];
  client: AgentClient;
  notify: (message: string, error?: boolean) => void;
  refreshProfile: () => Promise<AgentProfile>;
  refreshSchedules: () => Promise<unknown>;
}) {
  const tabs: Array<{id: Tab; label: string; icon: typeof Activity}> = [
    {id: "approvals", label: "Approvals", icon: ShieldCheck},
    {id: "profile", label: "Context", icon: Settings2},
    {id: "evals", label: "Evals", icon: FlaskConical},
  ];
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
            {id === "approvals" &&
              approvals.length + mcpAuthorizations.length > 0 && (
                <span>{approvals.length + mcpAuthorizations.length}</span>
              )}
          </button>
        ))}
      </div>
      <div className="inspector-content" role="tabpanel">
        {tab === "approvals" && (
          <ApprovalsPanel
            approvals={approvals}
            client={client}
            mcpAuthorizations={mcpAuthorizations}
            notify={notify}
          />
        )}
        {tab === "profile" && (
          <ProfilePanel
            client={client}
            notify={notify}
            profile={profile}
            refreshProfile={refreshProfile}
            refreshSchedules={refreshSchedules}
            schedules={schedules}
          />
        )}
        {tab === "evals" && <EvalsPanel notify={notify} />}
      </div>
    </aside>
  );
}

export function App({
  initialAgentId,
  agentName,
}: {
  initialAgentId: string;
  agentName: string;
}) {
  const [connection] = useState<AgentConnection>({
    agentId: initialAgentId,
  });
  const [mode, setMode] = useState<Mode>("ask");
  const [tab, setTab] = useState<Tab>("approvals");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [provisionalTurn, setProvisionalTurn] = useState<string>();
  const toastId = useRef(0);
  const agent = useAgent(connection);
  const pendingTurnId =
    agent.mcpAuthorizations[0]?.turnId ?? agent.approvals[0]?.turnId;
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
  useEffect(() => {
    const url = new URL(window.location.href);
    const oauthResult = url.searchParams.get("mcpAuth");
    if (!oauthResult) return;
    notify(
      oauthResult === "completed"
        ? "MCP authorization completed"
        : "MCP authorization failed",
      oauthResult !== "completed",
    );
    url.searchParams.delete("mcpAuth");
    window.history.replaceState(null, "", url);
  }, [notify]);

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
    hasPendingInput:
      agent.approvals.length > 0 || agent.mcpAuthorizations.length > 0,
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
      <main className="workspace">
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
              pendingAction={
                agent.mcpAuthorizations.length > 0 ? (
                  <section
                    aria-label="MCP authorization required"
                    className="conversation-authorization"
                    role="alert"
                  >
                    <div className="conversation-authorization-heading">
                      <span className="conversation-authorization-icon">
                        <KeyRound />
                      </span>
                      <div>
                        <strong>Connection required</strong>
                        <span>
                          This turn is waiting for you to connect an account.
                        </span>
                      </div>
                    </div>
                    <div className="card-list">
                      {agent.mcpAuthorizations.map((authorization) => (
                        <McpAuthorizationCard
                          authorization={authorization}
                          client={agent.client}
                          key={`conversation-mcp-${authorization.authRequestId}`}
                          notify={notify}
                        />
                      ))}
                    </div>
                  </section>
                ) : undefined
              }
            />
          </div>
          <StatusStrip turn={turn} />
          <Composer
            busy={Boolean(turn && !turn.terminal)}
            mode={mode}
            onSend={sendMessage}
            setMode={setMode}
          />
        </section>
        <Inspector
          approvals={agent.approvals}
          client={agent.client}
          mcpAuthorizations={agent.mcpAuthorizations}
          notify={notify}
          profile={agent.profile}
          refreshProfile={agent.refreshProfile}
          refreshSchedules={agent.refreshSchedules}
          schedules={agent.schedules}
          setTab={setTab}
          tab={tab}
        />
      </main>
      <Toasts toasts={toasts} />
    </div>
  );
}
