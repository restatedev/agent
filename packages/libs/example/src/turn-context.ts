// Pure projection between the Agent's canonical transcript and the model
// context used by one Turn invocation.

import type {ModelMessage} from "ai";
import type {ConversationEntry, SteeringSignal} from "./types.js";

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
      `The ${entry.queuedMessages} most recent user message(s) marked as queued are the input for this turn.`,
      "Process them now. Assistant messages or lifecycle events appearing after their original transcript positions did not answer them.",
    ].join("\n"),
  };
}

function userMessage(
  entry: Extract<ConversationEntry, {role: "user"}>,
): string {
  if (entry.delivery === "queued") {
    return [
      "[Queued user message]",
      "This arrived while another turn was active and was not part of that turn's input.",
      entry.text,
    ].join("\n");
  }
  if (entry.delivery !== "steer") {
    return entry.text;
  }
  return [
    "[Steering message delivered during the previous turn]",
    entry.text,
  ].join("\n");
}

export function buildModelContext(
  history: ConversationEntry[],
  summary?: string,
): ModelMessage[] {
  const uncompacted = history.flatMap((entry): ModelMessage[] => {
    if (entry.role === "user") {
      return [{role: "user", content: userMessage(entry)}];
    }
    if (entry.role === "event") {
      if (entry.type === "progress") {
        return [];
      }
      return [
        entry.type === "interrupt"
          ? interruptionBoundary(entry)
          : dispatchBoundary(entry),
      ];
    }
    return entry.status === "failed"
      ? [failureBoundary(entry)]
      : [{role: "assistant", content: entry.text}];
  });
  return summary
    ? [
        {
          role: "user",
          content: [
            "[Earlier conversation summary]",
            "This is context derived from older turns. Newer messages take precedence.",
            summary,
          ].join("\n"),
        },
        ...uncompacted,
      ]
    : uncompacted;
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

export function interruptionInstruction(reason: string): ModelMessage {
  return {
    role: "user",
    content: [
      "[Graceful interruption]",
      `User instruction: ${JSON.stringify(reason)}`,
      "Stop the original execution now and do not request any more tools.",
      "Using only completed results and runtime events already present above, give the best direct answer possible.",
      "Honor the user's interruption instruction, distinguish completed work from cancelled or incomplete work, and never invent missing results.",
    ].join("\n"),
  };
}
