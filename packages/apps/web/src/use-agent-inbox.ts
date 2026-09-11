import {useEffect, useMemo, useState, useSyncExternalStore} from "react";
import {createAgentInbox} from "./agent-inbox";
import {userClient} from "./user-client";

export function useAgentInbox(userId: string) {
  const [unavailable, setUnavailable] = useState(false);
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
    const abort = new AbortController();
    let polling = false;
    async function poll() {
      if (polling || document.visibilityState !== "visible") return;
      polling = true;
      const request = new AbortController();
      const cancel = () => request.abort();
      abort.signal.addEventListener("abort", cancel, {once: true});
      const deadline = window.setTimeout(cancel, 75_000);
      try {
        const completions = await userClient.agentCompletions(request.signal);
        if (!abort.signal.aborted) {
          inbox.observe(completions);
          setUnavailable(false);
        }
      } catch {
        // Preserve existing badges on failure and retry on the next tick/focus.
        if (!abort.signal.aborted) setUnavailable(true);
      } finally {
        window.clearTimeout(deadline);
        abort.signal.removeEventListener("abort", cancel);
        polling = false;
      }
    }
    const sync = (event: StorageEvent) => {
      if (event.key?.startsWith(inbox.prefix)) inbox.sync();
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    window.addEventListener("focus", poll);
    window.addEventListener("storage", sync);
    document.addEventListener("visibilitychange", poll);
    return () => {
      abort.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", poll);
      window.removeEventListener("storage", sync);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [inbox]);

  return {unread, markSeen: inbox.markSeen, unavailable};
}
