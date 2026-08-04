"use client";

import {
  Activity,
  AlarmClock,
  Ban,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FlaskConical,
  GitBranch,
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
import {Transcript} from "./transcript";
import {
  type AgentConnection,
  type AgentProfile,
  type ApprovalRequest,
  type ScheduledMessage,
  useAgent,
} from "./use-agent";

type Mode = "ask" | "steer" | "interrupt";
type Tab = "approvals" | "profile" | "evals";
type Guardrail = AgentProfile["guardrails"][number];

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
  "execution-limit",
  "context-reduction",
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

function activeTurn(entries: SequencedEntry[], provisional?: string) {
  const turns = new Map<
    string,
    {terminal: boolean; phase?: string; message?: string}
  >();
  let active = provisional;
  if (provisional) turns.set(provisional, {terminal: false});

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
      turn.phase = "tools";
      turn.message = `${entry.phase === "started" ? "Running" : "Finished"} ${entry.calls
        .map((call) => call.summary ?? call.name)
        .join(", ")}`;
    }
    if (!turn.terminal) active = turnId;
    turns.set(turnId, turn);
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
  connection,
  connected,
  error,
  onConnect,
  onNewAgent,
}: {
  connection: AgentConnection;
  connected: boolean;
  error?: string;
  onConnect: (agentId: string) => void;
  onNewAgent: () => void;
}) {
  const [agentId, setAgentId] = useState(connection.agentId);
  useEffect(() => {
    setAgentId(connection.agentId);
  }, [connection.agentId]);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <Bot />
        </div>
        <div>
          <strong>Restate Agent</strong>
          <span>durable runtime demo</span>
        </div>
      </div>
      <form
        className="connection-form"
        onSubmit={(event) => {
          event.preventDefault();
          onConnect(agentId);
        }}
      >
        <label>
          <span>Agent</span>
          <input
            aria-label="Agent ID"
            onChange={(event) => setAgentId(event.target.value)}
            spellCheck={false}
            value={agentId}
          />
        </label>
        <button className="button secondary compact" type="submit">
          Connect
        </button>
      </form>
      <div className="topbar-actions">
        <span
          className="connection-status"
          data-connected={connected}
          title={
            error ??
            (connected ? "Connected to the agent runtime" : "Connecting")
          }
        >
          <span className="connection-dot" />
          {connected ? "Live" : "Connecting"}
        </span>
        <button
          className="button ghost compact"
          onClick={onNewAgent}
          type="button"
        >
          <Plus /> New agent
        </button>
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
    const next = message.trim();
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
                : "Explain why the active turn should stop…"
          }
          ref={textarea}
          rows={2}
          value={message}
        />
        <button
          aria-label={MODE_COPY[mode].label}
          className="send-button"
          disabled={!message.trim() || sending}
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
          Human decisions requested by tools or guardrails appear here.
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

export function App({initialAgentId}: {initialAgentId: string}) {
  const [connection, setConnection] = useState<AgentConnection>({
    agentId: initialAgentId,
  });
  const [mode, setMode] = useState<Mode>("ask");
  const [tab, setTab] = useState<Tab>("approvals");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [provisionalTurn, setProvisionalTurn] = useState<string>();
  const toastId = useRef(0);
  const agent = useAgent(connection);
  const turn = useMemo(
    () => activeTurn(agent.entries, provisionalTurn),
    [agent.entries, provisionalTurn],
  );

  useEffect(() => {
    if (!turn) setProvisionalTurn(undefined);
  }, [turn]);
  useEffect(() => {
    document.title = `Restate Agent · ${connection.agentId}`;
  }, [connection.agentId]);

  function notify(message: string, error = false) {
    const id = ++toastId.current;
    setToasts((current) => [...current, {id, message, error}]);
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      error ? 6_000 : 3_200,
    );
  }

  function connect(agentId: string) {
    const nextAgent = agentId.trim() || "demo";
    const url = new URL(window.location.href);
    url.searchParams.set("agent", nextAgent);
    window.history.replaceState(null, "", url);
    setProvisionalTurn(undefined);
    setConnection({agentId: nextAgent});
  }

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
        connection={connection}
        error={agent.connectionError}
        onConnect={connect}
        onNewAgent={() =>
          connect(`agent-${Math.random().toString(36).slice(2, 8)}`)
        }
      />
      <main className="workspace">
        <section className="conversation-pane">
          <div className="conversation-heading">
            <div>
              <p className="eyebrow">Conversation</p>
              <h1>{connection.agentId}</h1>
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
