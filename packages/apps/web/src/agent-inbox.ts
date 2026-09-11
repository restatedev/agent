import type {SequencedEntry} from "./agent-client";

/** Only final responses count, never activity, tool results, or steering. */
export function lastTurnSequence(entries: SequencedEntry[]): number {
  return (
    entries.findLast(({entry}) => entry.role === "assistant")?.sequence ?? 0
  );
}

const EMPTY: ReadonlySet<string> = new Set();
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Server cursors plus browser-local, user-scoped read receipts. */
export function createAgentInbox(userId: string, storage: () => Storage) {
  const latest = new Map<string, number>();
  const seen = new Map<string, number>();
  const listeners = new Set<() => void>();
  let unread = EMPTY;
  const prefix = `restate:seen-turn:${encodeURIComponent(userId)}:`;
  const key = (agentId: string) => `${prefix}${encodeURIComponent(agentId)}`;

  function read(agentId: string) {
    let sequence = seen.get(agentId) ?? 0;
    try {
      const saved = Number(storage().getItem(key(agentId)));
      if (Number.isSafeInteger(saved) && saved >= 0) {
        sequence = Math.max(sequence, saved);
      }
    } catch {
      // Safari privacy settings/storage limits must not break the conversation.
    }
    seen.set(agentId, sequence);
    return sequence;
  }

  function sync() {
    const next = new Set(
      [...latest]
        .filter(([id, sequence]) => sequence > read(id))
        .map(([id]) => id),
    );
    if (next.size === unread.size && [...next].every((id) => unread.has(id)))
      return;
    unread = next;
    for (const notify of listeners) notify();
  }

  return {
    prefix,
    sync,
    getSnapshot: () => unread,
    getServerSnapshot: () => EMPTY,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    observe(completions: Array<{agentId: string; sequence: number}>) {
      for (const {agentId, sequence} of completions) {
        latest.set(agentId, Math.max(sequence, latest.get(agentId) ?? 0));
      }
      sync();
    },
    markSeen(agentId: string, sequence: number) {
      if (sequence <= 0) return;
      const previous = read(agentId);
      if (sequence > previous) {
        seen.set(agentId, sequence);
        try {
          storage().setItem(key(agentId), String(sequence));
        } catch {
          // Keep an in-memory receipt if storage is unavailable.
        }
      }
      sync();
    },
  };
}
