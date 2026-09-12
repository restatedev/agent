// Private durable workspace invalidations. No transcript or credential data.
import type {
  AgentNotificationSubscription,
  UserNotificationSnapshot,
} from "@restate-agents/types";
import {UserNotificationsDefinition} from "@restate-agents/types/services";
import * as restate from "@restatedev/restate-sdk-gen";
import {raceBranches} from "../race.js";
import {coordinationRetention} from "../retention.js";

const emptyVersions = {
  history: 0,
  profile: 0,
  approvals: 0,
  mcpAuth: 0,
  schedules: 0,
};
export const UserNotifications = restate.implement(
  UserNotificationsDefinition,
  {
    handlers: {
      *publish(change) {
        const previous = yield* snapshot();
        const revision = previous.revision + 1;
        const next: UserNotificationSnapshot = {...previous, revision};
        if (change.kind === "profile") next.profileRevision = revision;
        else {
          const old = Object.hasOwn(previous.agents, change.agentId)
            ? previous.agents[change.agentId]
            : undefined;
          next.agents = {
            ...previous.agents,
            [change.agentId]: {
              revision,
              versions: {
                ...(old?.versions ?? emptyVersions),
                [change.topic]: revision,
              },
            },
          };
        }
        restate.state().set("snapshot", next);
        const listeners = yield* subscriptions();
        restate.state().clear("subscriptions");
        for (const {awakeableId} of listeners)
          restate.resolveAwakeable(awakeableId, next);
      },
      *snapshot() {
        return yield* snapshot();
      },
      *watch(request) {
        const changed = restate.awakeable<UserNotificationSnapshot>();
        const client = restate.client(UserNotificationsDefinition, userKey());
        const available = yield* client.subscribe({
          afterRevision: request.afterRevision,
          awakeableId: changed.id,
        });
        if (available) return available;
        try {
          const result = yield* raceBranches({
            notification: changed.promise,
            timeout: restate.sleep(
              request.timeoutSeconds * 1000,
              "user notification watch",
            ),
          });
          if (result.tag === "notification") return result.value;
          yield* client.unsubscribe({awakeableId: changed.id});
          return yield* snapshot();
        } catch (error) {
          yield* restate
            .sendClient(UserNotificationsDefinition, userKey())
            .unsubscribe({awakeableId: changed.id});
          throw error;
        }
      },
      *subscribe(subscription) {
        const current = yield* snapshot();
        // A reset/future cursor must resynchronize instead of waiting forever.
        if (current.revision !== subscription.afterRevision) return current;
        const list = yield* subscriptions();
        if (!list.some((s) => s.awakeableId === subscription.awakeableId))
          restate.state().set("subscriptions", [...list, subscription]);
        return null;
      },
      *unsubscribe({awakeableId}) {
        const list = (yield* subscriptions()).filter(
          (s) => s.awakeableId !== awakeableId,
        );
        if (list.length) restate.state().set("subscriptions", list);
        else restate.state().clear("subscriptions");
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
function userKey() {
  const key = restate.handlerRequest().key;
  if (!key) throw new Error("UserNotifications requires a user key");
  return key;
}
function* snapshot(): restate.Operation<UserNotificationSnapshot> {
  return (
    (yield* restate
      .sharedState()
      .get<UserNotificationSnapshot>("snapshot")) ?? {
      revision: 0,
      profileRevision: 0,
      agents: {},
    }
  );
}
function* subscriptions(): restate.Operation<AgentNotificationSubscription[]> {
  return (
    (yield* restate
      .sharedState()
      .get<AgentNotificationSubscription[]>("subscriptions")) ?? []
  );
}
