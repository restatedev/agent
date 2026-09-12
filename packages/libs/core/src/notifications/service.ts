// Per-Agent invalidation stream for conversation consumers.
//
// Authoritative data remains with its owning Virtual Object: AgentSession owns
// history, while Agent owns profile, approvals, and MCP authorization state and
// AgentScheduler owns schedules. This object only records revision watermarks
// and parks watchers.
// Producers can therefore notify readers without coupling their state to the
// conversation controller.

import type {
  AgentNotificationSnapshot,
  AgentNotificationSubscription,
} from "@restate-agents/types";
import {
  AgentDefinition,
  AgentNotificationsDefinition,
  UserNotificationsDefinition,
} from "@restate-agents/types/services";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {raceBranches} from "../race.js";
import {coordinationRetention} from "../retention.js";

const SNAPSHOT = "snapshot";
const SUBSCRIPTIONS = "subscriptions";

const EMPTY_SNAPSHOT: AgentNotificationSnapshot = {
  revision: 0,
  versions: {
    history: 0,
    profile: 0,
    approvals: 0,
    mcpAuth: 0,
    schedules: 0,
  },
};

/** Durable invalidation stream keyed by the same agent ID as its producers. */
export const AgentNotifications = restate.implement(
  AgentNotificationsDefinition,
  {
    handlers: {
      /** Advances one topic watermark and wakes every eligible subscriber. */
      *publish(topic): restate.Operation<void> {
        const current = yield* readSnapshot();
        const revision = current.revision + 1;
        const snapshot: AgentNotificationSnapshot = {
          revision,
          versions: {...current.versions, [topic]: revision},
        };
        restate.state().set(SNAPSHOT, snapshot);

        // Route by immutable ownership, never a caller-provided user ID. Cache
        // only successful ownership lookups (also covers already-existing agents).
        let owner = yield* restate.state().get<string>("owner");
        if (!owner) {
          owner =
            (yield* restate
              .client(AgentDefinition, notificationKey())
              .ownership())?.ownerUserId ?? null;
          if (owner) restate.state().set("owner", owner);
        }
        if (owner)
          yield* restate
            .sendClient(UserNotificationsDefinition, owner)
            .publish({kind: "agent", agentId: notificationKey(), topic});

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
      },

      /** Returns the current global revision and per-topic watermarks. */
      *snapshot(): restate.Operation<AgentNotificationSnapshot> {
        return yield* readSnapshot();
      },

      /** Waits until any topic advances beyond the supplied revision. */
      *watch(request): restate.Operation<AgentNotificationSnapshot> {
        const changed = restate.awakeable<AgentNotificationSnapshot>();
        const available = yield* restate
          .client(AgentNotifications, notificationKey())
          .subscribe({
            afterRevision: request.afterRevision,
            awakeableId: changed.id,
          });
        if (available) {
          return available;
        }

        try {
          const selected = yield* raceBranches({
            notification: changed.promise,
            timeout: restate.sleep(
              request.timeoutSeconds * 1_000,
              "notification watch window",
            ),
          });
          if (selected.tag === "notification") {
            return selected.value;
          }

          yield* restate
            .client(AgentNotifications, notificationKey())
            .unsubscribe({awakeableId: changed.id});
          return yield* readSnapshot();
        } catch (error) {
          yield* restate
            .sendClient(AgentNotifications, notificationKey())
            .unsubscribe({awakeableId: changed.id});
          throw error;
        }
      },

      /** Registers a caller-owned awakeable unless a change is already available. */
      *subscribe(
        subscription,
      ): restate.Operation<AgentNotificationSnapshot | null> {
        const snapshot = yield* readSnapshot();
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
      },

      /** Removes an abandoned subscription. Safe to repeat. */
      *unsubscribe({awakeableId}): restate.Operation<void> {
        const subscriptions = yield* readSubscriptions();
        const remaining = subscriptions.filter(
          (subscription) => subscription.awakeableId !== awakeableId,
        );
        if (remaining.length !== subscriptions.length) {
          storeSubscriptions(remaining);
        }
      },
    },
    options: {
      enableLazyState: true,
      handlers: {
        publish: coordinationRetention,
        snapshot: {shared: true, ...coordinationRetention},
        watch: {
          shared: true,
          inactivityTimeout: {seconds: 1},
          ...coordinationRetention,
        },
        subscribe: coordinationRetention,
        unsubscribe: coordinationRetention,
      },
    },
  },
);

function* readSnapshot(): restate.Operation<AgentNotificationSnapshot> {
  return (
    (yield* restate.sharedState().get<AgentNotificationSnapshot>(SNAPSHOT)) ??
    EMPTY_SNAPSHOT
  );
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

function notificationKey(): string {
  const key = restate.handlerRequest().key;
  if (!key) {
    throw new TerminalError("AgentNotifications handlers require an agent key");
  }
  return key;
}
