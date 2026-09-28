// The compactor's model operations: AgentSession.compact summarizes the
// transcript between turns, and a turn summarizes its own working context
// when it runs low on room (session/turn-compaction.ts). State access and
// checkpoint application remain with their callers.

import type {
  ConversationCompactionResult,
  ConversationEntry,
} from "@restate-agents/types";
import {type Operation, run} from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";

import {errorMessage, isCancellation} from "../errors.js";
import {
  type ConversationCompactionInput,
  isDerivedConversationEvent,
} from "../internal-types.js";
import {modelProvider} from "./provider.js";

/** Summarizes a reserved, immutable transcript prefix for later model context. */
export function* compactConversation(
  request: ConversationCompactionInput,
): Operation<ConversationCompactionResult> {
  const range = {baseThrough: request.baseThrough, through: request.through};
  const input = {
    previousSummary: request.previousSummary ?? null,
    conversation: request.entries.flatMap(compactionView),
  };
  try {
    const summary = yield* run(
      ({signal}) => modelProvider.summarizeConversation(input, signal),
      {
        name: "compact-conversation",
        retry: {
          maxAttempts: 3,
          initialInterval: 500,
          maxInterval: 5_000,
          exponentiationFactor: 2,
        },
      },
    );
    return {status: "completed", ...range, summary};
  } catch (error) {
    // A failed summary is recorded so the range can be retried later; a
    // cancelled compaction must still propagate.
    if (isCancellation(error)) throw error;
    // The result schema rejects an empty error, and a rejected
    // applyCompaction would leave the reservation stuck.
    const message = errorMessage(error) || "conversation compaction failed";
    return {status: "failed", ...range, error: message};
  }
}

/**
 * Writes the handoff note for the older part of a turn's working context.
 * `request` is the user request the turn is working on, when those messages
 * include it. Errors other than cancellation escape after bounded retries.
 */
export function* summarizeTurnContext(
  messages: ModelMessage[],
  request: string | undefined,
): Operation<string> {
  const input = {
    request: request ?? null,
    messages: messages.map(messageView),
  };
  return yield* run(({signal}) => modelProvider.summarizeTurn(input, signal), {
    name: "compact-turn-context",
    retry: {
      maxAttempts: 3,
      initialInterval: 500,
      maxInterval: 5_000,
      exponentiationFactor: 2,
    },
  });
}

// Each text and tool payload the compactor reads is clipped. The recent
// messages stay verbatim in the context, and a long payload's detail rarely
// survives a summary anyway; this keeps the compactor's own input bounded.
const MAX_PART_CHARS = 16_000;

function clip(text: string): string {
  if (text.length <= MAX_PART_CHARS) {
    return text;
  }
  const omitted = text.length - MAX_PART_CHARS;
  return `${text.slice(0, MAX_PART_CHARS)} [${omitted} more characters omitted]`;
}

// What the compactor sees of a model message: its text, and each tool call
// and result by name. Reasoning and provider metadata are left out.
function messageView(message: ModelMessage): Record<string, unknown> {
  if (typeof message.content === "string") {
    return {role: message.role, text: clip(message.content)};
  }
  const parts: Record<string, unknown>[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case "text":
        parts.push({text: clip(part.text)});
        break;
      case "tool-call":
        parts.push({
          toolCall: part.toolName,
          id: part.toolCallId,
          input: clip(JSON.stringify(part.input) ?? ""),
        });
        break;
      case "tool-result":
        parts.push({
          toolResult: part.toolName,
          id: part.toolCallId,
          output: clip(JSON.stringify(part.output) ?? ""),
        });
        break;
    }
  }
  return {role: message.role, parts};
}

// What the compactor sees of an entry: message text with how it arrived or
// ended, and lifecycle boundaries, but none of the derived status events.
function compactionView(entry: ConversationEntry): Record<string, unknown>[] {
  switch (entry.role) {
    case "user":
      return [{role: "user", text: entry.text, delivery: entry.delivery}];
    case "assistant":
      return [
        {
          role: "assistant",
          text: entry.text,
          turnId: entry.turnId,
          status: entry.status,
        },
      ];
    case "event":
      return isDerivedConversationEvent(entry) ? [] : [entry];
  }
}
