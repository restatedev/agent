import {createHash} from "node:crypto";

export const MAX_ACTIVE_SUBAGENTS = 3;
export const MAX_SUBAGENTS_PER_TURN = 8;
export const MAX_SUBAGENT_STEPS = 20;
export const MAX_SUBAGENT_RESULT = 16_000;
export const SUBAGENT_BLOCKED_TOOLS = new Set([
  "runSubagent",
  "manageMemory",
  "scheduleMessage",
  "cancelSchedule",
  "listSchedules",
]);

/** Stable across replay, unique per parent invocation and tool call. */
export function subagentId(
  ownerAgentId: string,
  parentTurnId: string,
  toolCallId: string,
) {
  return `child-${createHash("sha256")
    .update(JSON.stringify([ownerAgentId, parentTurnId, toolCallId]))
    .digest("hex")
    .slice(0, 32)}`;
}

export function subagentTools(
  available: string[],
  selected: string[] | null,
): string[] {
  const permitted = new Set(
    available.filter((name) => !SUBAGENT_BLOCKED_TOOLS.has(name)),
  );
  if (selected?.some((name) => !permitted.has(name))) {
    throw new Error(
      "Sub-agent tools must be available in the parent turn; delegation, memory changes, and schedules are excluded.",
    );
  }
  return [...new Set(selected ?? permitted)];
}
