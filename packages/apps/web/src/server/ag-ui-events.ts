// Translates the agent's conversation history into AG-UI events and
// messages. History is the durable, append-only log that every turn writes
// as it works; AG-UI is a stream of UI events. Each history entry becomes the
// events a client needs to show it, so a client that reconnects can rebuild
// its whole view from the log.
//
// Two things do not map one to one, and both come from the log:
// - Model calls are journaled whole, so an answer arrives as a single
//   TEXT_MESSAGE_CONTENT, never token by token.
// - A tool call is recorded by name and a short summary, never by its
//   arguments or output, so TOOL_CALL_ARGS is always "{}" and a result
//   carries the call's status.
import {type Event, EventType, type Message} from "@ag-ui/core";
import type {HistoryPage} from "@restate-agents/types";

export type SequencedEntry = HistoryPage["entries"][number];
type ConversationEntry = SequencedEntry["entry"];
type ToolsEntry = Extract<ConversationEntry, {type: "tools"}>;
type ToolActivity = ToolsEntry["calls"][number];

const HISTORY_ID_PREFIX = "seq-";

/**
 * The AG-UI message ID of a history entry. It is stable, so the same entry
 * keeps its ID in a live stream and in a later snapshot.
 */
export function historyMessageId(sequence: number): string {
  return `${HISTORY_ID_PREFIX}${sequence}`;
}

/**
 * The history sequence a message ID was minted from, or undefined for an ID
 * the client made up, such as the one on a message it is sending now.
 */
export function historySequence(messageId: string): number | undefined {
  if (!messageId.startsWith(HISTORY_ID_PREFIX)) {
    return undefined;
  }
  const sequence = Number(messageId.slice(HISTORY_ID_PREFIX.length));
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    return undefined;
  }
  return sequence;
}

/** The events that show one history entry to a client. */
export function entryEvents({sequence, entry}: SequencedEntry): Event[] {
  const messageId = historyMessageId(sequence);
  if (entry.role === "user") {
    return textMessage(messageId, "user", entry.text);
  }
  if (entry.role === "assistant") {
    return textMessage(messageId, "assistant", entry.text, {
      turnId: entry.turnId,
      status: entry.status,
    });
  }
  switch (entry.type) {
    case "tools":
      return toolEvents(messageId, entry);
    case "activity":
      return [
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId,
          activityType: "activity",
          content: {turnId: entry.turnId, message: entry.message},
        },
      ];
    case "progress":
      // One activity message per turn, replaced as the turn moves between
      // thinking, waiting and finalizing.
      return [
        {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: `progress-${entry.turnId}`,
          activityType: "progress",
          content: {
            turnId: entry.turnId,
            phase: entry.phase,
            message: entry.message,
          },
          replace: true,
        },
      ];
    default:
      // Control events (steering, interrupts, queue dispatch, approvals and
      // memory changes) have no AG-UI counterpart. They travel as they are.
      return [
        {
          type: EventType.CUSTOM,
          name: `restate.${entry.type}`,
          value: entry,
        },
      ];
  }
}

/**
 * The conversation as AG-UI messages, for a MESSAGES_SNAPSHOT. It holds what
 * a chat view shows: user and assistant text, and each tool call with its
 * result. Activity and control events are left out.
 */
export function historyMessages(entries: SequencedEntry[]): Message[] {
  const messages: Message[] = [];
  for (const {sequence, entry} of entries) {
    const id = historyMessageId(sequence);
    if (entry.role === "user") {
      messages.push({id, role: "user", content: entry.text});
      continue;
    }
    if (entry.role === "assistant") {
      messages.push({id, role: "assistant", content: entry.text});
      continue;
    }
    if (entry.type !== "tools") {
      continue;
    }
    if (entry.phase === "started") {
      messages.push({
        id,
        role: "assistant",
        toolCalls: entry.calls.map((call) => ({
          id: call.id,
          type: "function",
          function: {name: call.name, arguments: "{}"},
          ...summaryMetadata(call),
        })),
      });
      continue;
    }
    for (const call of settledCalls(entry)) {
      messages.push({
        id: toolResultId(id, call),
        role: "tool",
        toolCallId: call.id,
        content: toolResultContent(call),
      });
    }
  }
  return messages;
}

function textMessage(
  messageId: string,
  role: "user" | "assistant",
  text: string,
  metadata?: Record<string, string>,
): Event[] {
  const events: Event[] = [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role,
      ...(metadata ? {metadata} : {}),
    },
  ];
  // A content event must carry a non-empty delta.
  if (text.length > 0) {
    events.push({type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text});
  }
  events.push({type: EventType.TEXT_MESSAGE_END, messageId});
  return events;
}

/**
 * A batch of calls opens as one assistant message holding every call, and
 * closes with a result per call. Arguments are not recorded, so each call's
 * arguments are the empty object.
 */
function toolEvents(messageId: string, entry: ToolsEntry): Event[] {
  if (entry.phase === "started") {
    return entry.calls.flatMap((call): Event[] => [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: call.id,
        toolCallName: call.name,
        parentMessageId: messageId,
        ...summaryMetadata(call),
      },
      {type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: "{}"},
      {type: EventType.TOOL_CALL_END, toolCallId: call.id},
    ]);
  }
  return settledCalls(entry).map((call): Event => ({
    type: EventType.TOOL_CALL_RESULT,
    messageId: toolResultId(messageId, call),
    toolCallId: call.id,
    content: toolResultContent(call),
  }));
}

/**
 * The calls of a finished batch that have their final result. A pending
 * call (a timer, an approval, a program handed off to run in the background)
 * is reported again, with its final status, when it completes.
 */
function settledCalls(entry: ToolsEntry): ToolActivity[] {
  return entry.calls.filter((call) => call.status !== "pending");
}

function toolResultId(messageId: string, call: ToolActivity): string {
  return `${messageId}-${call.id}`;
}

function toolResultContent(call: ToolActivity): string {
  return call.status ?? "finished";
}

function summaryMetadata(call: ToolActivity) {
  if (!call.summary) {
    return {};
  }
  return {metadata: {summary: call.summary}};
}
