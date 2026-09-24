// Agent is the durable conversation controller. It is a Virtual Object keyed
// by agent id, so its exclusive handlers serialize every decision about the
// active turn, queued messages, profile, approvals, schedules and children.
//
// It never runs a turn itself: AgentSession.doTurn does, and reports back to
// `onTurnEnd`. Each concern lives in its own module, which owns its state and
// publishes its notification topic; this file only assembles them.

import {AgentDefinition} from "@restate-agents/types/services";
import * as restate from "@restatedev/restate-sdk-gen";

import {
  askRetention,
  coordinationRetention,
  interactionRetention,
  noRetention,
} from "../retention.js";
import * as approvals from "./approvals.js";
import * as lifecycle from "./lifecycle.js";
import * as notifications from "./notifications.js";
import * as profile from "./profile.js";
import * as schedules from "./schedules.js";
import * as subAgents from "./sub-agents.js";
import * as turns from "./turns.js";

const shared = (retention: object) => ({shared: true, ...retention});
// Called only by AgentSession, other agents or the Agent itself. Ingress
// callers would bypass the turn and grant checks these calls rely on.
const internal = (retention: object) => ({ingressPrivate: true, ...retention});

export const Agent = restate.implement(AgentDefinition, {
  handlers: {
    ...turns.handlers,
    ...lifecycle.handlers,
    ...profile.handlers,
    ...approvals.handlers,
    ...schedules.handlers,
    ...subAgents.handlers,
    ...notifications.handlers,
  },
  options: {
    enableLazyState: true,
    handlers: {
      ask: askRetention,
      interrupt: interactionRetention,
      steer: interactionRetention,
      deliver: noRetention,
      onTurnEnd: internal(noRetention),

      initialize: internal(coordinationRetention),
      retire: coordinationRetention,
      metadata: shared(noRetention),

      profile: shared(noRetention),
      updateProfile: noRetention,
      deleteMemory: noRetention,
      updateMemory: internal(noRetention),
      toolCatalog: shared(noRetention),

      requestApproval: internal(coordinationRetention),
      cancelApproval: internal(coordinationRetention),
      resolveApproval: coordinationRetention,
      approvals: shared(noRetention),

      createSchedule: coordinationRetention,
      cancelSchedule: coordinationRetention,
      fire: internal(coordinationRetention),
      schedules: shared(noRetention),

      createSubAgent: internal(coordinationRetention),
      startSubAgentTask: internal(coordinationRetention),
      finishSubAgentTask: internal(coordinationRetention),
      deleteSubAgent: internal(coordinationRetention),
      listSubAgents: internal(noRetention),
      children: shared(noRetention),
      startDelegatedTurn: internal(coordinationRetention),
      interruptDelegatedTurn: internal(coordinationRetention),

      publish: internal(coordinationRetention),
      subscribe: internal(coordinationRetention),
      unsubscribe: internal(coordinationRetention),
      notifications: shared(coordinationRetention),
      watch: {
        ...shared(coordinationRetention),
        inactivityTimeout: {seconds: 1},
      },
    },
  },
});
