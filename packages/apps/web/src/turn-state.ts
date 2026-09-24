// The live turn shown in the status strip, reconstructed from the transcript.
import type {SequencedEntry} from "./agent-client";
import {
  describeToolBatch,
  type EventEntry,
  entryTurnId,
} from "./transcript-entries";

type TurnProgress = {terminal: boolean; phase?: string; message?: string};

export type ActiveTurn = TurnProgress & {turnId: string};

/** The phase and message an event implies, or undefined if it implies none. */
function progressOf(entry: EventEntry) {
  switch (entry.type) {
    case "progress":
      return {phase: entry.phase, message: entry.message};
    case "activity":
      return {phase: "thinking", message: entry.message};
    case "tools": {
      const phase = entry.phase === "started" ? "tools" : "thinking";
      return {phase, message: describeToolBatch(entry)};
    }
    case "interrupt":
      return {phase: "finalizing", message: "Finalizing the interrupted turn"};
    case "stop":
      return {phase: "finalizing", message: "Finalizing the stopped turn"};
    default:
      return undefined;
  }
}

/**
 * Reconstructs the visible turn from the append-only transcript. A newly
 * accepted turn or pending approval can lead the next history poll, so both
 * serve as temporary hints until its events arrive.
 */
export function activeTurn(
  entries: SequencedEntry[],
  provisional?: string,
  pendingTurnId?: string,
): ActiveTurn | undefined {
  const turns = new Map<string, TurnProgress>();
  const turn = (turnId: string) => {
    let progress = turns.get(turnId);
    if (!progress) {
      progress = {terminal: false};
      turns.set(turnId, progress);
    }
    return progress;
  };

  let active = pendingTurnId ?? provisional;
  for (const hint of [provisional, pendingTurnId]) {
    if (hint) {
      turn(hint);
    }
  }

  for (const {entry} of entries) {
    // The assistant entry is a turn's terminal summary.
    if (entry.role === "assistant") {
      turn(entry.turnId).terminal = true;
      if (active === entry.turnId) {
        active = undefined;
      }
      continue;
    }
    const turnId = entryTurnId(entry);
    if (entry.role !== "event" || !turnId) {
      continue;
    }
    const progress = turn(turnId);
    Object.assign(progress, progressOf(entry));
    if (!progress.terminal) {
      active = turnId;
    }
  }

  // An unfinished hint wins: its events may not have arrived yet.
  for (const hint of [pendingTurnId, provisional]) {
    if (hint && !turns.get(hint)?.terminal) {
      active = hint;
      break;
    }
  }
  if (!active) {
    return undefined;
  }
  return {turnId: active, ...turn(active)};
}

/** Whether a turn is still running, and so can be steered or interrupted. */
export function isRunning(turn: ActiveTurn | undefined) {
  return Boolean(turn && !turn.terminal);
}
