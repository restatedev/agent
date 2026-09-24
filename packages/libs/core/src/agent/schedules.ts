// Durable schedules and their timer lifecycle.
//
// Each schedule stores the invocation ID of its next delayed `Agent.fire`.
// Replacing, cancelling or advancing a schedule replaces that ID, so a stale
// or duplicate firing finds a mismatch and does nothing. Because firing and
// cancellation share Agent's exclusive lock, a cancel either lands before the
// firing (which is then stale) or after its delivery; it never races it.

import type {ScheduledMessage} from "@restate-agents/types";
import {AgentDefinition} from "@restate-agents/types/services";
import {rpc} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

import {listState, objectKey} from "../state.js";
import {
  type AgentHandlers,
  isDeleted,
  readMetadata,
  requireLive,
  requireTurnTool,
} from "./guards.js";
import * as notifications from "./notifications.js";
import {route} from "./turns.js";

type StoredSchedule = ScheduledMessage & {timerId: string};

const schedules = listState<StoredSchedule>("schedules");
const MAX_SCHEDULES = 32;

export const handlers: AgentHandlers<
  "createSchedule" | "cancelSchedule" | "schedules" | "fire"
> = {
  // Model-created schedules outlive their turn, so a turn caller is checked
  // against the live turn's grants. Direct callers (the UI) omit `turnId`.
  *createSchedule({turnId, ...spec}) {
    yield* requireLive();
    if (turnId !== undefined)
      yield* requireTurnTool(
        turnId,
        "createSchedule",
        "This agent cannot create schedules",
      );
    if ((yield* readMetadata()).parentAgentId)
      return {accepted: false, error: "Sub-agents cannot schedule messages"};

    const all = yield* schedules.get();
    const index = all.findIndex((s) => s.scheduleId === spec.scheduleId);
    if (index < 0 && all.length >= MAX_SCHEDULES)
      return {
        accepted: false,
        error: `schedules are limited to ${MAX_SCHEDULES} entries`,
      };
    if (index >= 0) restate.invocation(all[index].timerId).cancel();
    const timer = yield* createTimer(spec.scheduleId, spec.delaySeconds);
    const schedule: ScheduledMessage = {
      scheduleId: spec.scheduleId,
      message: spec.message,
      repeatEverySeconds: spec.repeatEverySeconds,
      whenBusy: spec.whenBusy,
      nextRunAt: timer.nextRunAt,
    };
    const stored = {...schedule, timerId: timer.id};
    yield* write(index < 0 ? [...all, stored] : all.with(index, stored));
    return {accepted: true, replaced: index >= 0, schedule};
  },

  *cancelSchedule({turnId, scheduleId}) {
    yield* requireLive();
    if (turnId !== undefined)
      yield* requireTurnTool(
        turnId,
        "cancelSchedule",
        "This agent cannot cancel schedules",
      );
    const all = yield* schedules.get();
    const removed = all.find((s) => s.scheduleId === scheduleId);
    if (removed) {
      restate.invocation(removed.timerId).cancel();
      yield* write(all.filter((s) => s !== removed));
    }
    return {accepted: true, cancelled: removed !== undefined};
  },

  *schedules() {
    return (yield* schedules.get()).map(toPublic);
  },

  /**
   * A schedule's delayed timer. A stale or duplicate firing is ignored. A due
   * one-shot is removed and a recurrence gets its next timer before the
   * message routes like any external delivery.
   */
  *fire({scheduleId}) {
    if (yield* isDeleted()) return;
    const all = yield* schedules.get();
    const index = all.findIndex((s) => s.scheduleId === scheduleId);
    const schedule = all[index];
    if (schedule?.timerId !== restate.handlerRequest().id) return;
    if (schedule.repeatEverySeconds === null) {
      yield* write(all.toSpliced(index, 1));
    } else {
      const timer = yield* createTimer(scheduleId, schedule.repeatEverySeconds);
      yield* write(
        all.with(index, {
          ...schedule,
          nextRunAt: timer.nextRunAt,
          timerId: timer.id,
        }),
      );
    }
    yield* route({
      source: "schedule",
      sourceId: scheduleId,
      message: schedule.message,
      whenBusy: schedule.whenBusy,
      interruptReason: `Scheduled message "${scheduleId}" became due`,
      // Skip a run while the previous one is still queued or running.
      coalesce: true,
    });
  },
};

/** Cancels every timer and forgets every schedule. */
export function* clearAll(): restate.Operation<void> {
  const all = yield* schedules.get();
  for (const schedule of all) restate.invocation(schedule.timerId).cancel();
  if (all.length > 0) yield* write([]);
}

function* write(all: StoredSchedule[]): restate.Operation<void> {
  schedules.set(all);
  yield* notifications.publish("schedules");
}

function* createTimer(
  scheduleId: string,
  delaySeconds: number,
): restate.Operation<{id: string; nextRunAt: number}> {
  const delay = delaySeconds * 1_000;
  const nextRunAt = (yield* restate.date().now()) + delay;
  const timer = yield* restate
    .sendClient(AgentDefinition, objectKey())
    .fire({scheduleId}, rpc.sendOpts({delay}));
  return {id: timer.id, nextRunAt};
}

function toPublic({
  timerId: _timerId,
  ...schedule
}: StoredSchedule): ScheduledMessage {
  return schedule;
}
