import {Activity, GitBranch, Sparkles} from "lucide-react";
import type {ReactNode} from "react";

import {shortTurn} from "./format";
import {type ActiveTurn, isRunning} from "./turn-state";

function connectionLabel(connected: boolean, error?: string) {
  if (connected) {
    return "Live";
  }
  return error ? "Offline" : "Connecting";
}

/**
 * The one-line top bar: agent name, agent navigation (as children), the
 * durable event count and whether the long poll is connected.
 */
export function ConnectionHeader({
  name,
  connected,
  error,
  eventCount,
  children,
}: {
  name: string;
  connected: boolean;
  error?: string;
  eventCount: number;
  children?: ReactNode;
}) {
  const label = connectionLabel(connected, error);
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <GitBranch aria-hidden="true" />
        </div>
        <div className="brand-copy">
          <h1 title={name}>{name}</h1>
          <span>Restate Agent</span>
        </div>
      </div>
      {children}
      <div className="topbar-actions">
        <span
          className="conversation-stat"
          title={`${eventCount} durable events`}
        >
          <Activity aria-hidden="true" />
          {eventCount}
          <span className="stat-label">durable events</span>
        </span>
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

/** One line above the composer: idle, or the running turn's phase. */
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
