import {useCallback, useEffect, useMemo, useRef, useState} from "react";

import {
  type AgentClient,
  type AgentSnapshot,
  createAgentClient,
} from "./agent-client";
import {mergeAgentSnapshot} from "./agent-snapshot";

type Connection = {
  /** The client this state was loaded through. */
  client: AgentClient;
  snapshot?: AgentSnapshot;
  status: "connecting" | "connected" | "failed";
  error?: string;
};

/** One mounted conversation owns one cursor and one cancellable long poll. */
export function useAgent(agentId: string) {
  const client = useMemo(() => createAgentClient(agentId), [agentId]);
  const [stored, setConnection] = useState<Connection>({
    client,
    status: "connecting",
  });
  // State is tagged with its client, so a new agent ID renders as connecting
  // with no data, without the effect having to reset state first.
  const connection: Connection =
    stored.client === client ? stored : {client, status: "connecting"};
  const {snapshot, status, error} = connection;
  // The poll reads the latest merged result without restarting on each render.
  const latest = useRef<AgentSnapshot | undefined>(undefined);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry: (() => void) | undefined;
    latest.current = undefined;
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
          setConnection({client, snapshot: current, status: "connected"});
        } catch (failure) {
          if (abort.signal.aborted) return;
          setConnection({
            client,
            snapshot: latest.current,
            status: "failed",
            error: failure instanceof Error ? failure.message : String(failure),
          });
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
      const updated = {...latest.current, profile};
      latest.current = updated;
      setConnection((current) =>
        current.client === client ? {...current, snapshot: updated} : current,
      );
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
