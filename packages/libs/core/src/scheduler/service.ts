// Per-Agent durable schedules and their timer lifecycle.
//
// This Virtual Object is keyed by agent ID. It owns schedule state, delayed
// invocations, recurrence, stale-timer rejection, and cancellation. When its
// own delayed invocation fires, it advances state and delivers a generic
// external message to Agent for conversation routing.

import type {ScheduledMessage} from "@restate-agents/types";
import {
  AgentDefinition,
  AgentNotificationsDefinition,
  AgentSchedulerDefinition,
} from "@restate-agents/types/services";
import {rpc, TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {coordinationRetention, noRetention} from "../retention.js";

type StoredSchedule = ScheduledMessage & {
  timerId: string;
};

const SCHEDULES = "schedules";
const MAX_SCHEDULES = 32;

/** Durable schedule registry and timer lifecycle for one Agent. */
export const AgentScheduler = restate.implement(AgentSchedulerDefinition, {
  handlers: {
    *retire() {
      restate.state().set("deleted", true);
      for (const schedule of yield* readSchedules())
        restate.invocation(schedule.timerId).cancel();
      restate.state().clear(SCHEDULES);
      yield* publishChange();
    },
    /** Creates or replaces a schedule and installs its next durable timer. */
    *upsert(spec) {
      if (yield* restate.state().get<boolean>("deleted"))
        return {accepted: false as const, error: "Agent has been deleted"};
      const existing = yield* getSchedule(spec.scheduleId);
      if (existing) {
        restate.invocation(existing.timerId).cancel();
      }

      const timer = yield* createTimer(spec.scheduleId, spec.delaySeconds);
      const schedule: ScheduledMessage = {
        scheduleId: spec.scheduleId,
        message: spec.message,
        repeatEverySeconds: spec.repeatEverySeconds,
        whenBusy: spec.whenBusy,
        nextRunAt: timer.nextRunAt,
      };
      const stored = yield* storeSchedule(schedule, timer.id);
      if ("error" in stored) {
        restate.invocation(timer.id).cancel();
        return {accepted: false as const, error: stored.error};
      }
      yield* publishChange();
      return {
        accepted: true as const,
        replaced: stored.replaced,
        schedule,
      };
    },

    /** Cancels one active schedule and its current delayed invocation. */
    *cancel({scheduleId}) {
      const removed = yield* removeSchedule(scheduleId);
      if (!removed) {
        return {accepted: true as const, cancelled: false};
      }
      restate.invocation(removed.timerId).cancel();
      yield* publishChange();
      return {accepted: true as const, cancelled: true};
    },

    /** Returns the authoritative public schedule snapshot. */
    *list(): restate.Operation<ScheduledMessage[]> {
      return (yield* readSchedules()).map(toPublicSchedule);
    },

    /** Advances one valid timer and delivers its message to Agent. */
    *fire({scheduleId}): restate.Operation<void> {
      const schedule = yield* getSchedule(scheduleId);
      if (schedule?.timerId !== restate.handlerRequest().id) {
        return;
      }

      if (schedule.repeatEverySeconds === null) {
        yield* removeSchedule(scheduleId);
      } else {
        const timer = yield* createTimer(
          scheduleId,
          schedule.repeatEverySeconds,
        );
        const stored = yield* storeSchedule(
          {...schedule, nextRunAt: timer.nextRunAt},
          timer.id,
        );
        if ("error" in stored) {
          throw new TerminalError(stored.error);
        }
      }
      yield* publishChange();
      yield* restate.client(AgentDefinition, schedulerKey()).deliver({
        source: "schedule",
        sourceId: schedule.scheduleId,
        message: schedule.message,
        whenBusy: schedule.whenBusy,
        interruptReason: `Scheduled message "${schedule.scheduleId}" became due`,
      });
    },
  },
  options: {
    handlers: {
      upsert: coordinationRetention,
      cancel: coordinationRetention,
      retire: coordinationRetention,
      list: {shared: true, ...noRetention},
      fire: coordinationRetention,
    },
  },
});

function* createTimer(
  scheduleId: string,
  delaySeconds: number,
): restate.Operation<{id: string; nextRunAt: number}> {
  const delay = delaySeconds * 1_000;
  const nextRunAt = (yield* restate.date().now()) + delay;
  const timer = yield* restate
    .sendClient(AgentScheduler, schedulerKey())
    .fire({scheduleId}, rpc.sendOpts({delay}));
  return {id: timer.id, nextRunAt};
}

function* publishChange(): restate.Operation<void> {
  yield* restate
    .sendClient(AgentNotificationsDefinition, schedulerKey())
    .publish("schedules");
}

function* getSchedule(
  scheduleId: string,
): restate.Operation<StoredSchedule | undefined> {
  return (yield* readSchedules()).find(
    (schedule) => schedule.scheduleId === scheduleId,
  );
}

function* storeSchedule(
  schedule: ScheduledMessage,
  timerId: string,
): restate.Operation<{replaced: boolean} | {error: string}> {
  const all = yield* readSchedules();
  const index = all.findIndex(
    (candidate) => candidate.scheduleId === schedule.scheduleId,
  );
  if (index < 0 && all.length >= MAX_SCHEDULES) {
    return {error: `schedules are limited to ${MAX_SCHEDULES} entries`};
  }

  const stored = {...schedule, timerId};
  if (index < 0) {
    all.push(stored);
  } else {
    all[index] = stored;
  }
  writeSchedules(all);
  return {replaced: index >= 0};
}

function* removeSchedule(
  scheduleId: string,
): restate.Operation<StoredSchedule | undefined> {
  const all = yield* readSchedules();
  const index = all.findIndex((schedule) => schedule.scheduleId === scheduleId);
  if (index < 0) {
    return undefined;
  }
  const [removed] = all.splice(index, 1);
  writeSchedules(all);
  return removed;
}

function* readSchedules(): restate.Operation<StoredSchedule[]> {
  return (yield* restate.sharedState().get<StoredSchedule[]>(SCHEDULES)) ?? [];
}

function writeSchedules(all: StoredSchedule[]): void {
  if (all.length === 0) {
    restate.state().clear(SCHEDULES);
  } else {
    restate.state().set(SCHEDULES, all);
  }
}

function toPublicSchedule({
  scheduleId,
  message,
  repeatEverySeconds,
  whenBusy,
  nextRunAt,
}: StoredSchedule): ScheduledMessage {
  return {
    scheduleId,
    message,
    repeatEverySeconds,
    whenBusy,
    nextRunAt,
  };
}

function schedulerKey(): string {
  const key = restate.handlerRequest().key;
  if (!key) {
    throw new TerminalError("AgentScheduler handlers require an agent key");
  }
  return key;
}
