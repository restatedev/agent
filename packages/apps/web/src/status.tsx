import {GitBranch, Sparkles} from "lucide-react";

import {shortTurn} from "./format";
import {type ActiveTurn, isRunning} from "./turn-state";

function connectionLabel(connected: boolean, error?: string) {
  if (connected) {
    return "Live";
  }
  return error ? "Offline" : "Connecting";
}

/** The top bar: agent name and whether the long poll is connected. */
export function ConnectionHeader({
  name,
  connected,
  error,
}: {
  name: string;
  connected: boolean;
  error?: string;
}) {
  const label = connectionLabel(connected, error);
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
          title={error ?? label}
        >
          <span className="connection-dot" />
          {label}
        </span>
      </div>
    </header>
  );
}

/** One line under the transcript: idle, or the running turn's phase. */
export function StatusStrip({turn}: {turn?: ActiveTurn}) {
  if (!turn || !isRunning(turn)) {
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
