import {useEffect, useMemo, useSyncExternalStore} from "react";
import {createAgentInbox} from "./agent-inbox";

/** Completion markers come from the workspace feed; only receipts are local. */
export function useAgentInbox(
  userId: string,
  completions: Array<{agentId: string; sequence: number}>,
  unavailable: boolean,
) {
  const inbox = useMemo(
    () => createAgentInbox(userId, () => window.localStorage),
    [userId],
  );
  const unread = useSyncExternalStore(
    inbox.subscribe,
    inbox.getSnapshot,
    inbox.getServerSnapshot,
  );
  useEffect(() => {
    inbox.observe(completions);
  }, [inbox, completions]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key?.startsWith(inbox.prefix)) inbox.sync();
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [inbox]);
  return {unread, markSeen: inbox.markSeen, unavailable};
}
