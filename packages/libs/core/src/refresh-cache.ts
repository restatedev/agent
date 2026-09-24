// Process-local cache for catalogs read over the network (the Restate Admin
// API, MCP servers). It lives outside any invocation; callers read it inside
// a `restate.run`, which journals the value a turn actually used.

type Refreshed<V> = {value: V; warnings: string[]};

type Entry<V> = {value: V; refreshAfter: number; lastAccessedAt: number};

/**
 * Concurrent callers share one refresh per key. The caller that finds the
 * value expired starts the refresh and waits for it; while it runs, other
 * callers with a stale value keep using it rather than waiting on network
 * I/O. A failed refresh falls back to the stale value with a warning and
 * retries after `retryAfterMs`. Past `maxEntries`, the least recently read
 * entry is evicted.
 */
export function createRefreshingCache<V>(options: {
  retryAfterMs: number;
  maxEntries?: number;
}) {
  const entries = new Map<string, Entry<V>>();
  const refreshes = new Map<string, Promise<Refreshed<V>>>();

  function store(key: string, entry: Entry<V>): void {
    entries.set(key, entry);
    if (entries.size <= (options.maxEntries ?? Infinity)) {
      return;
    }
    const evicted = leastRecentlyRead(entries, key);
    if (evicted !== undefined) {
      entries.delete(evicted);
    }
  }

  return {
    /**
     * @param fetch Reads a fresh value and how long it stays fresh.
     * @param staleWarning Describes a failed refresh that fell back.
     * @param signal Stops this caller waiting; the shared refresh continues.
     */
    get(
      key: string,
      fetch: () => Promise<{value: V; ttlMs: number; warnings: string[]}>,
      staleWarning: (error: unknown) => string,
      signal: AbortSignal,
    ): Promise<Refreshed<V>> {
      const now = Date.now();
      const cached = entries.get(key);
      if (cached) {
        cached.lastAccessedAt = now;
        if (now < cached.refreshAfter) {
          return Promise.resolve({value: cached.value, warnings: []});
        }
      }
      const inFlight = refreshes.get(key);
      if (inFlight && cached) {
        return Promise.resolve({value: cached.value, warnings: []});
      }
      if (inFlight) {
        return abortable(inFlight, signal);
      }

      // The refresh is shared, so its lifetime is not tied to this caller.
      const refresh = fetch()
        .then(({value, ttlMs, warnings}) => {
          store(key, {
            value,
            refreshAfter: Date.now() + ttlMs,
            lastAccessedAt: Date.now(),
          });
          return {value, warnings};
        })
        .catch((error: unknown) => {
          if (!cached) throw error;
          cached.refreshAfter = Date.now() + options.retryAfterMs;
          return {value: cached.value, warnings: [staleWarning(error)]};
        })
        .finally(() => refreshes.delete(key));
      refreshes.set(key, refresh);
      return abortable(refresh, signal);
    },
  };
}

function leastRecentlyRead<V>(
  entries: Map<string, Entry<V>>,
  except: string,
): string | undefined {
  let oldest: {key: string; lastAccessedAt: number} | undefined;
  for (const [key, {lastAccessedAt}] of entries) {
    if (key === except) {
      continue;
    }
    if (!oldest || lastAccessedAt < oldest.lastAccessedAt) {
      oldest = {key, lastAccessedAt};
    }
  }
  return oldest?.key;
}

/** Settles with `promise`, or rejects as soon as `signal` aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, {once: true});
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}
