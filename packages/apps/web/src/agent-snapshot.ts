import type {AgentSnapshot, AgentSnapshotUpdate} from "./agent-client";

/** Merge a retried history page without losing or duplicating earlier events. */
export function mergeAgentSnapshot(
  current: AgentSnapshot,
  update: AgentSnapshotUpdate,
): AgentSnapshot {
  if (update.notification.revision < current.notification.revision)
    return current;
  const history = update.history
    ? {
        entries: [
          ...new Map(
            [...current.history.entries, ...update.history.entries].map(
              (entry) => [entry.sequence, entry],
            ),
          ).values(),
        ].sort((a, b) => a.sequence - b.sequence),
        nextSequence: Math.max(
          current.history.nextSequence,
          update.history.nextSequence,
        ),
      }
    : current.history;
  return {...current, ...update, history};
}
