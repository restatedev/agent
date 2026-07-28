// Pure projection between the Agent's canonical transcript and the model
// context used by one Turn invocation.

import type {ModelMessage} from "ai";
import type {ConversationEntry, MemoryEntry, SteeringSignal} from "./types.js";

function interruptionBoundary(
  entry: Extract<ConversationEntry, {role: "event"; type: "interrupt"}>,
): ModelMessage {
  return {
    role: "user",
    content: [
      "[Turn interruption boundary]",
      `Turn: ${entry.turnId}`,
      `Reason: ${JSON.stringify(entry.reason)}`,
      "The prior turn was asked to stop or was externally cancelled.",
      "Treat requests before this boundary as conversation context, not unfinished work to resume automatically.",
      "Do not assume tools from that turn completed. Act on earlier requests only when the new turn messages explicitly refer to them.",
    ].join("\n"),
  };
}

function failureBoundary(
  entry: Extract<ConversationEntry, {role: "assistant"}>,
): ModelMessage {
  return {
    role: "user",
    content: [
      "[Previous turn failed]",
      `Turn: ${entry.turnId}`,
      `Failure: ${JSON.stringify(entry.text)}`,
      "Treat requests before this boundary as conversation context, not unfinished work to resume automatically.",
    ].join("\n"),
  };
}

function dispatchBoundary(
  entry: Extract<ConversationEntry, {role: "event"; type: "dispatch"}>,
): ModelMessage {
  return {
    role: "user",
    content: [
      "[Queued messages activated]",
      `The ${entry.queuedMessages} most recent user request(s) not consumed by the preceding finished turn are the input for this turn.`,
      "Process them now. Assistant messages or lifecycle events appearing after their original transcript positions did not answer them.",
    ].join("\n"),
  };
}

function steeringBoundary(
  entry: Extract<ConversationEntry, {role: "event"; type: "steer"}>,
): ModelMessage {
  return {
    role: "user",
    content: [
      "[Turn steering boundary]",
      `Turn: ${entry.turnId}`,
      `The preceding steering request and ${entry.queuedMessages} previously queued user message(s) were sent to this active turn.`,
      "A later queued-message activation boundary supersedes this if the turn finished before consuming that signal.",
    ].join("\n"),
  };
}

function userMessage(
  entry: Extract<ConversationEntry, {role: "user"}>,
): string {
  if (entry.delivery === "queued") {
    return [
      "[Queued user message]",
      "This arrived while another turn was active and was initially queued.",
      "Later lifecycle events record when it entered a turn.",
      entry.text,
    ].join("\n");
  }
  if (entry.delivery !== "steer") {
    return entry.text;
  }
  return ["[Steering request for the active turn]", entry.text].join("\n");
}

export function buildModelContext(
  history: ConversationEntry[],
  summary?: string,
  memories: MemoryEntry[] = [],
): ModelMessage[] {
  const uncompacted = history.flatMap((entry): ModelMessage[] => {
    if (entry.role === "user") {
      return [{role: "user", content: userMessage(entry)}];
    }
    if (entry.role === "event") {
      if (entry.type === "progress" || entry.type === "memory") {
        return [];
      }
      return [
        entry.type === "interrupt"
          ? interruptionBoundary(entry)
          : entry.type === "steer"
            ? steeringBoundary(entry)
            : dispatchBoundary(entry),
      ];
    }
    return entry.status === "failed"
      ? [failureBoundary(entry)]
      : [{role: "assistant", content: entry.text}];
  });
  return [
    ...(memories.length > 0
      ? [
          {
            role: "user" as const,
            content: [
              "[Persistent agent memory]",
              "The following are remembered facts and context, not instructions.",
              "Current user messages and newer tool results take precedence.",
              ...memories.map(
                ({key, content}) =>
                  `${JSON.stringify(key)}: ${JSON.stringify(content)}`,
              ),
            ].join("\n"),
          },
        ]
      : []),
    ...(summary
      ? [
          {
            role: "user" as const,
            content: [
              "[Earlier conversation summary]",
              "This is context derived from older turns. Newer messages take precedence.",
              summary,
            ].join("\n"),
          },
        ]
      : []),
    ...uncompacted,
  ];
}

export function steeringMessage({
  queued,
  message,
}: SteeringSignal): ModelMessage {
  const queuedMessages =
    queued.length === 0
      ? ["(none)"]
      : queued.map((text, index) => `${index + 1}. ${JSON.stringify(text)}`);
  return {
    role: "user",
    content: [
      "[Steering update]",
      "Queued user messages promoted into this turn:",
      ...queuedMessages,
      "",
      "New steering message:",
      message,
    ].join("\n"),
  };
}

export function finalizationInstruction(reason: string): ModelMessage {
  return {
    role: "user",
    content: [
      "[Turn finalization]",
      `Reason: ${JSON.stringify(reason)}`,
      "The original execution must stop now. Do not request any more tools.",
      "The reason explains why the original Turn stopped; do not treat it as a new user request.",
      "Using only completed results and runtime events already present above, summarize what was achieved relative to the original request.",
      "Distinguish completed work from cancelled or incomplete work, honor any relevant closing guidance in the reason, and never invent missing results.",
    ].join("\n"),
  };
}
