import type {
  AgentMetadata,
  AgentNotificationSnapshot,
  AgentProfile,
  ApprovalRequest,
  ChildAgent,
  HistoryPage,
  ScheduledMessage,
} from "@restate-agents/types";

/** Everything the conversation view renders, as one proxy response. */
export type AgentSnapshot = {
  notification: AgentNotificationSnapshot;
  profile: AgentProfile;
  approvals: ApprovalRequest[];
  schedules: ScheduledMessage[];
  metadata: AgentMetadata;
  children: ChildAgent[];
  history: HistoryPage;
};

/** The new watermark plus only the parts it invalidated. */
export type AgentSnapshotUpdate = Pick<AgentSnapshot, "notification"> &
  Partial<Omit<AgentSnapshot, "notification">>;

/** Merge a retried history page without losing or duplicating earlier events. */
export function mergeAgentSnapshot(
  current: AgentSnapshot,
  update: AgentSnapshotUpdate,
): AgentSnapshot {
  if (update.notification.revision < current.notification.revision) {
    return current;
  }
  const history = update.history
    ? mergeHistory(current.history, update.history)
    : current.history;
  return {...current, ...update, history};
}

function mergeHistory(current: HistoryPage, update: HistoryPage): HistoryPage {
  const bySequence = new Map(
    [...current.entries, ...update.entries].map((entry) => [
      entry.sequence,
      entry,
    ]),
  );
  return {
    entries: [...bySequence.values()].sort((a, b) => a.sequence - b.sequence),
    nextSequence: Math.max(current.nextSequence, update.nextSequence),
  };
}
