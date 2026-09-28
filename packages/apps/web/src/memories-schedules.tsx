import type {MemoryIndexEntry, ScheduledMessage} from "@restate-agents/types";

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
    <p>
      <strong>{memory.id}</strong>: {memory.description}
      {!readOnly && (
        <button type="button" onClick={() => void remove()}>
          Delete
        </button>
      )}
    </p>
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
    <p>
      <strong>{scheduleId}</strong>: {schedule.message} ·{" "}
      {new Date(schedule.nextRunAt).toLocaleString()}
      {!readOnly && (
        <button type="button" onClick={() => void cancel()}>
          Cancel
        </button>
      )}
    </p>
  );
}

/** A collapsed view of the agent's saved memories and scheduled messages. */
export function MemoriesAndSchedules({
  memories,
  schedules,
  ...props
}: Props & {memories: MemoryIndexEntry[]; schedules: ScheduledMessage[]}) {
  return (
    <details className="demo-state">
      <summary>Memories and schedules</summary>
      <h3>Agent memories</h3>
      {memories.length === 0 && (
        <p>
          No saved memories. Ask this agent to remember something for a later
          turn.
        </p>
      )}
      {memories.map((memory) => (
        <MemoryRow key={memory.id} memory={memory} {...props} />
      ))}
      <h3>Scheduled messages</h3>
      {schedules.length === 0 && (
        <p>No scheduled messages. Ask this agent to schedule a reminder.</p>
      )}
      {schedules.map((schedule) => (
        <ScheduleRow key={schedule.scheduleId} schedule={schedule} {...props} />
      ))}
    </details>
  );
}
