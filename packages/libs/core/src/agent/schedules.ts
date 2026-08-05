// Durable scheduled messages owned by one Agent virtual object. This module is
// only a handler-scoped state namespace; timing and conversation routing stay
// in the Agent handlers so they share the Agent's exclusive ordering.

import type {ScheduledMessage} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";

type StoredSchedule = ScheduledMessage & {
  timerId: string;
};

const SCHEDULES = "schedules";
const MAX_SCHEDULES = 32;

function* readSchedules(): restate.Operation<StoredSchedule[]> {
  return (yield* restate.sharedState().get<StoredSchedule[]>(SCHEDULES)) ?? [];
}

function visible({
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

function store(all: StoredSchedule[]): void {
  if (all.length === 0) {
    restate.state().clear(SCHEDULES);
  } else {
    restate.state().set(SCHEDULES, all);
  }
}

/**
 * Handler-scoped access to scheduled messages for the current Agent object.
 *
 * Exclusive Agent handlers serialize mutations. Shared readers receive only
 * the public schedule view; delayed invocation IDs remain an implementation
 * detail used to reject stale timer deliveries.
 */
export function* list(): restate.Operation<ScheduledMessage[]> {
  return (yield* readSchedules()).map(visible);
}

export function* get(
  scheduleId: string,
): restate.Operation<StoredSchedule | undefined> {
  return (yield* readSchedules()).find(
    (schedule) => schedule.scheduleId === scheduleId,
  );
}

export function* set(
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
  store(all);
  return {replaced: index >= 0};
}

export function* remove(
  scheduleId: string,
): restate.Operation<StoredSchedule | undefined> {
  const all = yield* readSchedules();
  const index = all.findIndex((schedule) => schedule.scheduleId === scheduleId);
  if (index < 0) {
    return undefined;
  }
  const [removed] = all.splice(index, 1);
  store(all);
  return removed;
}
