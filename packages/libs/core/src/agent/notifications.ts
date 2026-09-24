// Per-Agent invalidation stream for conversation consumers.
//
// Authoritative data stays with its owner: AgentSession owns history, while
// Agent owns profile, approvals and schedules. This module only records
// watermarks and wakes parked watchers. Agent-owned modules publish when they
// write; AgentSession calls `Agent.publish` after appending history.

import type {
  AgentNotificationSnapshot,
  AgentNotificationSubscription,
  AgentNotificationTopic,
} from "@restate-agents/types";
import {AgentDefinition} from "@restate-agents/types/services";
import * as restate from "@restatedev/restate-sdk-gen";

import {listState, objectKey} from "../state.js";
import {raceBranches} from "../tasks.js";
import type {AgentHandlers} from "./guards.js";

const SNAPSHOT = "notifications";
const subscriptions = listState<AgentNotificationSubscription>(
  "notification-subscriptions",
);

const EMPTY_SNAPSHOT: AgentNotificationSnapshot = {
  revision: 0,
  versions: {history: 0, profile: 0, approvals: 0, schedules: 0},
};

export const handlers: AgentHandlers<
  "publish" | "notifications" | "watch" | "subscribe" | "unsubscribe"
> = {
  /** Advances a topic owned by another object (AgentSession history). */
  *publish(topic) {
    yield* publish(topic);
  },

  *notifications() {
    return yield* read();
  },

  /**
   * Waits for a revision newer than `afterRevision`, for at most the window.
   * Runs as a shared handler, so it parks outside Agent's exclusive lock; the
   * exclusive `subscribe` rechecks the watermark, so a publish between the
   * caller's read and registration still wakes it.
   */
  *watch({afterRevision, timeoutSeconds}) {
    const changed = restate.awakeable<AgentNotificationSnapshot>();
    const agent = restate.client(AgentDefinition, objectKey());
    const available = yield* agent.subscribe({
      afterRevision,
      awakeableId: changed.id,
    });
    if (available) return available;
    try {
      const selected = yield* raceBranches({
        notification: changed.promise,
        timeout: restate.sleep(
          timeoutSeconds * 1_000,
          "notification watch window",
        ),
      });
      if (selected.tag === "notification") return selected.value;
      yield* agent.unsubscribe({awakeableId: changed.id});
      return yield* read();
    } catch (error) {
      yield* restate
        .sendClient(AgentDefinition, objectKey())
        .unsubscribe({awakeableId: changed.id});
      throw error;
    }
  },

  /** Registers a caller-owned awakeable unless a change is already available. */
  *subscribe(subscription) {
    const snapshot = yield* read();
    if (subscription.afterRevision < snapshot.revision) return snapshot;
    yield* subscriptions.update((all) =>
      all.some(({awakeableId}) => awakeableId === subscription.awakeableId)
        ? all
        : [...all, subscription],
    );
    return null;
  },

  /** Removes an abandoned subscription. Safe to repeat. */
  *unsubscribe({awakeableId}) {
    yield* subscriptions.update((all) =>
      all.filter((subscription) => subscription.awakeableId !== awakeableId),
    );
  },
};

/** Returns the current global revision and per-topic watermarks. */
export function* read(): restate.Operation<AgentNotificationSnapshot> {
  return (
    (yield* restate.sharedState().get<AgentNotificationSnapshot>(SNAPSHOT)) ??
    EMPTY_SNAPSHOT
  );
}

/**
 * Advances one topic watermark and wakes every eligible subscriber. Must run
 * in an exclusive Agent handler.
 */
export function* publish(
  topic: AgentNotificationTopic,
): restate.Operation<void> {
  const current = yield* read();
  const revision = current.revision + 1;
  const snapshot: AgentNotificationSnapshot = {
    revision,
    versions: {...current.versions, [topic]: revision},
  };
  restate.state().set(SNAPSHOT, snapshot);

  const all = yield* subscriptions.get();
  const ready = all.filter(({afterRevision}) => afterRevision < revision);
  if (ready.length === 0) return;
  subscriptions.set(all.filter(({afterRevision}) => afterRevision >= revision));
  for (const {awakeableId} of ready)
    restate.resolveAwakeable(awakeableId, snapshot);
}
