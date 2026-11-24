import type {MemoryIndexEntry, ScheduledMessage} from "@restate-agents/types";
import {Brain, CalendarClock, Trash2, X} from "lucide-react";

import type {UiAgentClient} from "./agent-client";
import {type Notify, runAction} from "./format";

type Props = {
  client: UiAgentClient;
  notify: Notify;
  readOnly: boolean;
};

function MemoryRow({
  memory,
  client,
  notify,
  readOnly,
}: Props & {memory: MemoryIndexEntry}) {
  function remove() {
    return runAction(notify, async () => {
      const existed = await client.deleteMemory(memory.id);
      if (!existed) {
        return [`Memory ${memory.id} was already gone`, true];
      }
      return `Memory ${memory.id} deleted`;
    });
  }

  return (
    <li className="state-row">
      <div>
        <code>{memory.id}</code>
        <p>{memory.description}</p>
      </div>
      {!readOnly && (
        <button
          aria-label={`Delete memory ${memory.id}`}
          className="icon-button danger"
          onClick={() => void remove()}
          title="Delete memory"
          type="button"
        >
          <Trash2 />
        </button>
      )}
    </li>
  );
}

function ScheduleRow({
  schedule,
  client,
  notify,
  readOnly,
}: Props & {schedule: ScheduledMessage}) {
  const {scheduleId} = schedule;

  function cancel() {
    return runAction(notify, async () => {
      const result = await client.cancelSchedule(scheduleId);
      if (!result.accepted) {
        return [result.error, true];
      }
      if (!result.cancelled) {
        return [`Schedule "${scheduleId}" was already gone`, true];
      }
      return `Schedule "${scheduleId}" cancelled`;
    });
  }

  return (
    <li className="state-row">
      <div>
        <code>{scheduleId}</code>
        <p>{schedule.message}</p>
        <small>Next run {new Date(schedule.nextRunAt).toLocaleString()}</small>
      </div>
      {!readOnly && (
        <button
          aria-label={`Cancel schedule ${scheduleId}`}
          className="icon-button danger"
          onClick={() => void cancel()}
          title="Cancel schedule"
          type="button"
        >
          <X />
        </button>
      )}
    </li>
  );
}

/** The Memory tab: the agent's saved memories and scheduled messages. */
export function MemoriesAndSchedules({
  memories,
  schedules,
  ...props
}: Props & {memories: MemoryIndexEntry[]; schedules: ScheduledMessage[]}) {
  return (
    <div className="settings-sections">
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <Brain />
            <span>
              <strong>Memories</strong>
              <small>Saved across turns</small>
            </span>
          </div>
        </div>
        {memories.length === 0 ? (
          <p className="section-copy">
            No saved memories. Ask this agent to remember something for a later
            turn.
          </p>
        ) : (
          <ul className="state-list">
            {memories.map((memory) => (
              <MemoryRow key={memory.id} memory={memory} {...props} />
            ))}
          </ul>
        )}
      </section>
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <CalendarClock />
            <span>
              <strong>Scheduled messages</strong>
              <small>One-off and recurring</small>
            </span>
          </div>
        </div>
        {schedules.length === 0 ? (
          <p className="section-copy">
            No scheduled messages. Ask this agent to schedule a reminder.
          </p>
        ) : (
          <ul className="state-list">
            {schedules.map((schedule) => (
              <ScheduleRow
                key={schedule.scheduleId}
                schedule={schedule}
                {...props}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
