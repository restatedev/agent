// Durable schedules for one Agent and their timer lifecycle.
//
// Each schedule stores the invocation ID of its next delayed `Agent.fire`.
// Replacing, cancelling or advancing a schedule replaces that ID, so a stale
// or duplicate firing finds a mismatch and does nothing. Because firing and
// cancellation share Agent's exclusive lock, a cancel either lands before the
// firing (which is then stale) or after its delivery; it never races it.
//
// These functions must run inside an exclusive Agent handler.

import type {ScheduledMessage, ScheduleSpec} from "@restate-agents/types";
import {AgentDefinition} from "@restate-agents/types/services";
import {rpc} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

type StoredSchedule = ScheduledMessage & {timerId: string};

const SCHEDULES = "schedules";
const MAX_SCHEDULES = 32;

/** Returns the public view of every active schedule. */
export function* list(): restate.Operation<ScheduledMessage[]> {
  return (yield* readSchedules()).map(toPublicSchedule);
}

/** Creates or replaces a schedule and installs its next durable timer. */
export function* upsert(
  agentId: string,
  spec: ScheduleSpec,
): restate.Operation<
  | {accepted: true; replaced: boolean; schedule: ScheduledMessage}
  | {accepted: false; error: string}
> {
  const all = yield* readSchedules();
  const index = all.findIndex(({scheduleId}) => scheduleId === spec.scheduleId);
  if (index < 0 && all.length >= MAX_SCHEDULES)
    return {
      accepted: false,
      error: `schedules are limited to ${MAX_SCHEDULES} entries`,
    };
  if (index >= 0) restate.invocation(all[index].timerId).cancel();

  const timer = yield* createTimer(agentId, spec.scheduleId, spec.delaySeconds);
  const schedule: ScheduledMessage = {
    scheduleId: spec.scheduleId,
    message: spec.message,
    repeatEverySeconds: spec.repeatEverySeconds,
    whenBusy: spec.whenBusy,
    nextRunAt: timer.nextRunAt,
  };
  const stored = {...schedule, timerId: timer.id};
  if (index < 0) all.push(stored);
  else all[index] = stored;
  writeSchedules(all);
  return {accepted: true, replaced: index >= 0, schedule};
}

/** Cancels one schedule and its pending timer. @returns whether it existed. */
export function* cancel(scheduleId: string): restate.Operation<boolean> {
  const all = yield* readSchedules();
  const index = all.findIndex((schedule) => schedule.scheduleId === scheduleId);
  if (index < 0) return false;
  const [removed] = all.splice(index, 1);
  restate.invocation(removed.timerId).cancel();
  writeSchedules(all);
  return true;
}

/**
 * Advances the schedule whose timer is the current invocation: a one-shot is
 * removed, a recurrence gets its next timer.
 *
 * @returns the schedule to deliver, or undefined for a stale firing.
 */
export function* advance(
  agentId: string,
  scheduleId: string,
): restate.Operation<ScheduledMessage | undefined> {
  const all = yield* readSchedules();
  const index = all.findIndex((schedule) => schedule.scheduleId === scheduleId);
  const schedule = all[index];
  if (schedule?.timerId !== restate.handlerRequest().id) return undefined;

  if (schedule.repeatEverySeconds === null) {
    all.splice(index, 1);
  } else {
    const timer = yield* createTimer(
      agentId,
      scheduleId,
      schedule.repeatEverySeconds,
    );
    all[index] = {...schedule, nextRunAt: timer.nextRunAt, timerId: timer.id};
  }
  writeSchedules(all);
  return toPublicSchedule(schedule);
}

/** Cancels every timer and forgets every schedule. @returns whether any existed. */
export function* clearAll(): restate.Operation<boolean> {
  const all = yield* readSchedules();
  for (const schedule of all) restate.invocation(schedule.timerId).cancel();
  restate.state().clear(SCHEDULES);
  return all.length > 0;
}

function* createTimer(
  agentId: string,
  scheduleId: string,
  delaySeconds: number,
): restate.Operation<{id: string; nextRunAt: number}> {
  const delay = delaySeconds * 1_000;
  const nextRunAt = (yield* restate.date().now()) + delay;
  const timer = yield* restate
    .sendClient(AgentDefinition, agentId)
    .fire({scheduleId}, rpc.sendOpts({delay}));
  return {id: timer.id, nextRunAt};
}

function* readSchedules(): restate.Operation<StoredSchedule[]> {
  return (yield* restate.sharedState().get<StoredSchedule[]>(SCHEDULES)) ?? [];
}

function writeSchedules(all: StoredSchedule[]): void {
  if (all.length === 0) restate.state().clear(SCHEDULES);
  else restate.state().set(SCHEDULES, all);
}

function toPublicSchedule({
  scheduleId,
  message,
  repeatEverySeconds,
  whenBusy,
  nextRunAt,
}: StoredSchedule): ScheduledMessage {
  return {scheduleId, message, repeatEverySeconds, whenBusy, nextRunAt};
}
