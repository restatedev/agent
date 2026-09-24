import {
  Ban,
  GitBranch,
  type LucideIcon,
  MessageSquareText,
  RefreshCw,
  Send,
} from "lucide-react";
import {type KeyboardEvent, useRef, useState} from "react";

import type {UiAgentClient} from "./agent-client";
import {errorMessage, type Notify, runAction, shortTurn} from "./format";

const MODES = ["ask", "steer", "interrupt"] as const;
type Mode = (typeof MODES)[number];

const MODE_COPY: Record<
  Mode,
  {label: string; description: string; placeholder: string; icon: LucideIcon}
> = {
  ask: {
    label: "Ask",
    description: "Starts a turn when idle; queues behind an active turn.",
    placeholder: "Ask the agent to do something…",
    icon: MessageSquareText,
  },
  steer: {
    label: "Steer",
    description:
      "Guides the current turn after its active tool batch completes.",
    placeholder: "Guide the active turn…",
    icon: GitBranch,
  },
  interrupt: {
    label: "Interrupt",
    description: "Stops unfinished work and asks the turn for a final summary.",
    placeholder: "Optional: explain why the active turn should stop…",
    icon: Ban,
  },
};

// The protocol requires a reason; the UI supplies one when the user gives none.
const DEFAULT_INTERRUPT_REASON = "Interrupted by the user.";

type Send = (
  mode: Mode,
  message: string,
  replacement?: string,
) => Promise<void>;

/**
 * Delivers one composer message in the chosen mode and reports the outcome.
 * Failures are reported and rethrown, so the composer keeps the draft.
 */
function useSend(
  client: UiAgentClient,
  notify: Notify,
  onTurnStarted: (turnId: string) => void,
): Send {
  async function ask(message: string) {
    const result = await client.ask(message);
    if (result.decision === "start") {
      onTurnStarted(result.turnId);
      notify(`Turn started: ${shortTurn(result.turnId)}`);
      return;
    }
    const pending = result.stats.pendingMessages;
    const behind = shortTurn(result.activeTurnId);
    notify(`Queued (${pending} pending) behind ${behind}`);
  }

  async function steer(message: string) {
    const accepted = await client.steer(message);
    if (accepted) {
      notify("Steering delivered to the active turn");
    } else {
      notify("No turn is accepting steering", true);
    }
  }

  async function interrupt(reason: string, replacement?: string) {
    const accepted = await client.interrupt(reason, replacement);
    if (accepted) {
      notify("Interruption requested");
    } else {
      notify("Nothing to interrupt", true);
    }
  }

  return async (mode, message, replacement) => {
    try {
      if (mode === "ask") {
        await ask(message);
      } else if (mode === "steer") {
        await steer(message);
      } else {
        await interrupt(message, replacement);
      }
    } catch (error) {
      notify(errorMessage(error), true);
      throw error;
    }
  };
}

/** The text to send, or undefined when this mode has nothing to send. */
function outgoingMessage(mode: Mode, draft: string) {
  const trimmed = draft.trim();
  if (trimmed) {
    return trimmed;
  }
  // Ask and steer need a message; only interrupt has a default.
  if (mode === "interrupt") {
    return DEFAULT_INTERRUPT_REASON;
  }
  return undefined;
}

function ModeSwitcher({
  mode,
  setMode,
}: {
  mode: Mode;
  setMode: (mode: Mode) => void;
}) {
  return (
    <div className="mode-row">
      <fieldset className="mode-switcher" aria-label="Message delivery mode">
        {MODES.map((candidate) => {
          const {icon: Icon, label} = MODE_COPY[candidate];
          return (
            <button
              data-active={mode === candidate}
              key={candidate}
              onClick={() => setMode(candidate)}
              type="button"
            >
              <Icon />
              {label}
            </button>
          );
        })}
      </fieldset>
      <span className="mode-description">{MODE_COPY[mode].description}</span>
    </div>
  );
}

function SendIcon({mode, sending}: {mode: Mode; sending: boolean}) {
  if (sending) {
    return <RefreshCw className="spin" />;
  }
  return mode === "interrupt" ? <Ban /> : <Send />;
}

/** Message input for a top-level agent: ask, steer or interrupt. */
export function Composer({
  client,
  notify,
  busy,
  onTurnStarted,
}: {
  client: UiAgentClient;
  notify: Notify;
  busy: boolean;
  onTurnStarted: (turnId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("ask");
  const [message, setMessage] = useState("");
  const [replacement, setReplacement] = useState("");
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const send = useSend(client, notify, onTurnStarted);

  // Interrupt can go without a message, but only while there is a turn.
  const canSend = mode === "interrupt" ? busy : Boolean(message.trim());

  async function submit() {
    const outgoing = outgoingMessage(mode, message);
    if (!outgoing || sending) {
      return;
    }
    setSending(true);
    try {
      await send(mode, outgoing, replacement.trim() || undefined);
      setMessage("");
      if (mode === "interrupt") {
        setReplacement("");
      }
    } catch {
      // useSend already reported the failure; keep the draft for a retry.
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

  const copy = MODE_COPY[mode];
  return (
    <div className="composer-shell">
      <ModeSwitcher mode={mode} setMode={setMode} />
      <div className="composer-box" data-mode={mode}>
        <textarea
          aria-label={`${copy.label} message`}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={copy.placeholder}
          ref={textarea}
          rows={2}
          value={message}
        />
        <button
          aria-label={copy.label}
          className="send-button"
          disabled={sending || !canSend}
          onClick={() => void submit()}
          type="button"
        >
          <SendIcon mode={mode} sending={sending} />
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

/**
 * A sub-agent only takes tasks from its parent, so its page offers just an
 * interrupt (and points at pending approvals).
 */
export function ChildControls({
  client,
  notify,
  busy,
  awaitingApproval,
}: {
  client: UiAgentClient;
  notify: Notify;
  busy: boolean;
  awaitingApproval: boolean;
}) {
  function interrupt() {
    return runAction(notify, async () => {
      const accepted = await client.interrupt(DEFAULT_INTERRUPT_REASON);
      if (!accepted) {
        return ["Nothing to interrupt", true];
      }
      return "Interruption requested";
    });
  }

  return (
    <div className="composer-shell">
      <p className="empty-copy">
        Sub-agent conversation — only its parent can send tasks and follow-ups.
      </p>
      <button
        type="button"
        className="button secondary"
        disabled={!busy}
        onClick={() => void interrupt()}
      >
        <Ban /> Interrupt
      </button>
      {awaitingApproval && (
        <p className="empty-copy">
          This child is waiting for approval. Use the Approvals panel to
          respond, or interrupt its task.
        </p>
      )}
    </div>
  );
}
