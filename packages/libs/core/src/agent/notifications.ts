// Per-Agent invalidation stream for conversation consumers.
//
// Authoritative data stays with its owner: AgentSession owns history, while
// Agent owns profile, approvals and schedules. This module only records
// watermarks and wakes parked watchers. Agent-owned topics publish inline;
// AgentSession sends `Agent.publish` after appending history.

import type {
  AgentNotificationSnapshot,
  AgentNotificationSubscription,
  AgentNotificationTopic,
} from "@restate-agents/types";
import {AgentDefinition} from "@restate-agents/types/services";
import * as restate from "@restatedev/restate-sdk-gen";

import {raceBranches} from "../race.js";

const SNAPSHOT = "notifications";
const SUBSCRIPTIONS = "notification-subscriptions";

const EMPTY_SNAPSHOT: AgentNotificationSnapshot = {
  revision: 0,
  versions: {
    history: 0,
    profile: 0,
    approvals: 0,
    schedules: 0,
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

  const subscriptions = yield* readSubscriptions();
  const ready = subscriptions.filter(
    ({afterRevision}) => afterRevision < revision,
  );
  if (ready.length === 0) return;
  storeSubscriptions(
    subscriptions.filter(({afterRevision}) => afterRevision >= revision),
  );
  for (const {awakeableId} of ready) {
    restate.resolveAwakeable(awakeableId, snapshot);
  }
}

/**
 * Registers a caller-owned awakeable unless a change is already available.
 * Must run in an exclusive Agent handler.
 */
export function* subscribe(
  subscription: AgentNotificationSubscription,
): restate.Operation<AgentNotificationSnapshot | null> {
  const snapshot = yield* read();
  if (subscription.afterRevision < snapshot.revision) return snapshot;

  const subscriptions = yield* readSubscriptions();
  if (
    !subscriptions.some(
      ({awakeableId}) => awakeableId === subscription.awakeableId,
    )
  ) {
    subscriptions.push(subscription);
    restate.state().set(SUBSCRIPTIONS, subscriptions);
  }
  return null;
}

/** Removes an abandoned subscription. Safe to repeat. */
export function* unsubscribe(awakeableId: string): restate.Operation<void> {
  const subscriptions = yield* readSubscriptions();
  const remaining = subscriptions.filter(
    (subscription) => subscription.awakeableId !== awakeableId,
  );
  if (remaining.length !== subscriptions.length) storeSubscriptions(remaining);
}

/**
 * Waits for a revision newer than `afterRevision`, for at most the window.
 * Runs in a shared handler, so it parks outside Agent's exclusive lock; the
 * exclusive `subscribe` rechecks the watermark, so a publish between the
 * caller's read and registration still wakes it.
 */
export function* watch(
  agentId: string,
  afterRevision: number,
  timeoutSeconds: number,
): restate.Operation<AgentNotificationSnapshot> {
  const changed = restate.awakeable<AgentNotificationSnapshot>();
  const agent = restate.client(AgentDefinition, agentId);
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
      .sendClient(AgentDefinition, agentId)
      .unsubscribe({awakeableId: changed.id});
    throw error;
  }
}

function* readSubscriptions(): restate.Operation<
  AgentNotificationSubscription[]
> {
  return (
    (yield* restate
      .sharedState()
      .get<AgentNotificationSubscription[]>(SUBSCRIPTIONS)) ?? []
  );
}

function storeSubscriptions(
  subscriptions: AgentNotificationSubscription[],
): void {
  if (subscriptions.length === 0) restate.state().clear(SUBSCRIPTIONS);
  else restate.state().set(SUBSCRIPTIONS, subscriptions);
}
