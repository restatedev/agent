// Durable notification subscriptions for one Agent virtual object.
//
// This is deliberately only an invalidation channel. AgentSession remains the
// source of truth for history, while the Agent remains the source of truth for
// profile, approvals, and schedules. Consumers wake here and then pull the
// authoritative state they care about.

import type {AgentNotificationSnapshot} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import type {
  AgentNotificationSubscription,
  AgentNotificationTopic,
} from "../internal-types.js";

const SNAPSHOT = "notifications/snapshot";
const SUBSCRIPTIONS = "notifications/subscriptions";

const EMPTY_SNAPSHOT: AgentNotificationSnapshot = {
  revision: 0,
  versions: {
    history: 0,
    profile: 0,
    approvals: 0,
    schedules: 0,
  },
};

/** Returns the current invalidation watermark for every authoritative area. */
export function* read(): restate.Operation<AgentNotificationSnapshot> {
  return (
    (yield* restate.sharedState().get<AgentNotificationSnapshot>(SNAPSHOT)) ??
    EMPTY_SNAPSHOT
  );
}

/**
 * Registers a caller-owned awakeable unless a notification already arrived.
 *
 * @returns The current snapshot when the caller should not wait, otherwise
 * `null` after storing the subscription.
 */
export function* subscribe(
  subscription: AgentNotificationSubscription,
): restate.Operation<AgentNotificationSnapshot | null> {
  const snapshot = yield* read();
  if (subscription.afterRevision < snapshot.revision) {
    return snapshot;
  }

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

/** Publishes one invalidation and forwards the new snapshot to subscribers. */
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
  if (ready.length === 0) {
    return;
  }

  storeSubscriptions(
    subscriptions.filter(({afterRevision}) => afterRevision >= revision),
  );
  for (const {awakeableId} of ready) {
    restate.resolveAwakeable(awakeableId, snapshot);
  }
}

/** Removes an abandoned subscription. Safe to repeat. */
export function* unsubscribe(awakeableId: string): restate.Operation<void> {
  const subscriptions = yield* readSubscriptions();
  const remaining = subscriptions.filter(
    (subscription) => subscription.awakeableId !== awakeableId,
  );
  if (remaining.length !== subscriptions.length) {
    storeSubscriptions(remaining);
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
  if (subscriptions.length === 0) {
    restate.state().clear(SUBSCRIPTIONS);
  } else {
    restate.state().set(SUBSCRIPTIONS, subscriptions);
  }
}
