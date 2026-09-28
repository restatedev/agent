// Tools over the agent's durable schedules. The Agent controller owns them
// and checks each change against the live turn and its grants.

import {
  type ScheduledMessage,
  ScheduleIdRequestSchema,
  ScheduleSpecSchema,
} from "@restate-agents/types";
import {AgentDefinition} from "@restate-agents/types/services";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";

import {agentCall, defineAgentTool, failed, succeeded} from "../tools-api.js";

export const createScheduleTool = defineAgentTool({
  name: "createSchedule",
  description:
    "Create or replace a durable schedule for this Agent that will deliver a future user request. Once accepted, the schedule persists independently of this Turn. Reuse a scheduleId to update it. Use queue unless the user explicitly asks the due message to steer or interrupt active work.",
  inputSchema: ScheduleSpecSchema,
  *run(schedule, context) {
    // A rejected grant is feedback for the model.
    const result = yield* agentCall([403], () =>
      restate
        .client(AgentDefinition, context.agentId)
        .createSchedule({...schedule, turnId: context.turnId}),
    );
    if ("status" in result) return result;
    if (!result.accepted) return failed(result.error);
    return succeeded(
      JSON.stringify({...result, schedule: withIsoTime(result.schedule)}),
    );
  },
});

export const cancelScheduleTool = defineAgentTool({
  name: "cancelSchedule",
  description:
    "Cancel one durable message scheduled for this Agent by its scheduleId. This is idempotent; cancelling an unknown schedule succeeds without changing anything.",
  inputSchema: ScheduleIdRequestSchema,
  *run({scheduleId}, context) {
    const result = yield* agentCall([403], () =>
      restate
        .client(AgentDefinition, context.agentId)
        .cancelSchedule({scheduleId, turnId: context.turnId}),
    );
    if ("status" in result) return result;
    if (!result.accepted) return failed(result.error);
    return succeeded(
      result.cancelled
        ? `Cancelled schedule ${scheduleId}`
        : `Schedule ${scheduleId} was not active`,
    );
  },
});

export const listSchedulesTool = defineAgentTool({
  name: "listSchedules",
  description:
    "List the Agent's active scheduled messages, including their next delivery time, recurrence, and busy-turn policy.",
  inputSchema: z.object({}),
  *run(_input, context) {
    const active = yield* restate
      .client(AgentDefinition, context.agentId)
      .schedules();
    return succeeded(JSON.stringify(active.map(withIsoTime)));
  },
});

// The model reads times more reliably as ISO strings than epoch millis.
function withIsoTime(schedule: ScheduledMessage) {
  return {...schedule, nextRunAt: new Date(schedule.nextRunAt).toISOString()};
}
