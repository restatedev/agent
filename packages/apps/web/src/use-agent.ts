import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {type AgentSnapshot, createAgentClient} from "./agent-client";
import {mergeAgentSnapshot} from "./agent-snapshot";

/** One mounted conversation owns one cursor and one cancellable long poll. */
export function useAgent(agentId: string) {
  const client = useMemo(() => createAgentClient(agentId), [agentId]);
  const [snapshot, setSnapshot] = useState<AgentSnapshot>();
  // The poll reads the latest merged result without restarting on each render.
  const latest = useRef<AgentSnapshot | undefined>(undefined);
  const [status, setStatus] = useState<"connecting" | "connected" | "failed">(
    "connecting",
  );
  const [error, setError] = useState<string>();

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry: (() => void) | undefined;
    setSnapshot(undefined);
    latest.current = undefined;
    setStatus("connecting");
    async function follow() {
      let windowKey = crypto.randomUUID();
      while (!abort.signal.aborted) {
        try {
          let current = latest.current;
          if (!current) current = await client.snapshot({signal: abort.signal});
          else {
            const update = await client.sync(
              current.notification,
              current.history.nextSequence,
              {signal: abort.signal, idempotencyKey: windowKey},
            );
            current = mergeAgentSnapshot(latest.current ?? current, update);
          }
          if (abort.signal.aborted) return;
          windowKey = crypto.randomUUID();
          latest.current = current;
          setSnapshot(current);
          setStatus("connected");
          setError(undefined);
        } catch (failure) {
          if (abort.signal.aborted) return;
          setStatus("failed");
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
          // Keep the window key so reconnecting attaches to the same wait.
          await new Promise<void>((resolve) => {
            retry = resolve;
            timer = setTimeout(resolve, 2_000);
          });
        }
      }
    }
    void follow();
    return () => {
      abort.abort();
      clearTimeout(timer);
      retry?.();
    };
  }, [client]);

  const refreshProfile = useCallback(async () => {
    const profile = await client.profile();
    if (latest.current) {
      latest.current = {...latest.current, profile};
      setSnapshot(latest.current);
    }
    return profile;
  }, [client]);

  return {
    client,
    entries: snapshot?.history.entries ?? [],
    profile: snapshot?.profile,
    metadata: snapshot?.metadata,
    children: snapshot?.children ?? [],
    schedules: snapshot?.schedules ?? [],
    approvals: snapshot?.approvals ?? [],
    connected: status === "connected",
    connectionStatus: status,
    connectionError: error,
    refreshProfile,
  };
}
