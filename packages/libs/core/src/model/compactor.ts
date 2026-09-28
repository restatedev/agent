// The model operation used by AgentSession.compact. State access and
// checkpoint application remain on the AgentSession virtual object.

import type {
  ConversationCompactionResult,
  ConversationEntry,
} from "@restate-agents/types";
import {type Operation, run} from "@restatedev/restate-sdk-gen";

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
