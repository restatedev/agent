// Narrowing helpers over transcript entries, shared by the transcript view
// and the live turn status.
import type {SequencedEntry} from "./agent-client";

export type TranscriptEntry = SequencedEntry["entry"];
export type EventEntry = Extract<TranscriptEntry, {role: "event"}>;
export type AssistantEntry = Extract<TranscriptEntry, {role: "assistant"}>;
export type ToolsEntry = Extract<EventEntry, {type: "tools"}>;

/** Event types rendered inside a turn card rather than as their own row. */
const DETAIL_TYPES = [
  "progress",
  "activity",
  "tools",
  "steer",
  "approval_cancelled",
] as const;

export type DetailEntry = Extract<
  EventEntry,
  {type: (typeof DETAIL_TYPES)[number]}
>;

export function isDetailEntry(entry: TranscriptEntry): entry is DetailEntry {
  if (entry.role !== "event") {
    return false;
  }
  // Widening the tuple to string[] lets includes() accept any event type.
  const detailTypes: readonly string[] = DETAIL_TYPES;
  return detailTypes.includes(entry.type);
}

/**
 * The turn an entry belongs to. Most entries carry one, but user messages,
 * dispatch markers and some deliveries do not.
 */
export function entryTurnId(entry: TranscriptEntry): string | undefined {
  if (!("turnId" in entry)) {
    return undefined;
  }
  return entry.turnId;
}

/** "Running a, b" or "Finished a, b" for one tool batch event. */
export function describeToolBatch(entry: ToolsEntry) {
  const verb = entry.phase === "started" ? "Running" : "Finished";
  const calls = entry.calls.map((call) => call.summary ?? call.name);
  return `${verb} ${calls.join(", ")}`;
}
