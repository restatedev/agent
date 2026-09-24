import type {ProfileUpdate} from "@restate-agents/types";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";

import {createUiClient} from "./agent-client";
import {type AgentSnapshot, mergeAgentSnapshot} from "./agent-snapshot";
import {errorMessage, type Notify, runAction} from "./format";

type Connection = {
  snapshot?: AgentSnapshot;
  status: "connecting" | "connected" | "failed";
  error?: string;
};

/**
 * One mounted conversation owns one cursor and one cancellable long poll.
 * The agent ID is fixed for the component's lifetime: the page keys the app
 * by agent ID, and agent navigation is a full page load.
 */
export function useAgent(agentId: string, notify: Notify) {
  const client = useMemo(() => createUiClient(agentId), [agentId]);
  const [connection, setConnection] = useState<Connection>({
    status: "connecting",
  });
  // The poll reads the latest merged result without restarting on each render.
  const latest = useRef<AgentSnapshot | undefined>(undefined);

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry: (() => void) | undefined;

    async function next(windowKey: string) {
      const current = latest.current;
      if (!current) {
        return client.snapshot({signal: abort.signal});
      }
      const update = await client.sync(
        current.notification,
        current.history.nextSequence,
        {signal: abort.signal, idempotencyKey: windowKey},
      );
      // A profile save may have replaced latest.current meanwhile.
      return mergeAgentSnapshot(latest.current ?? current, update);
    }

    async function follow() {
      let windowKey = crypto.randomUUID();
      while (!abort.signal.aborted) {
        try {
          const snapshot = await next(windowKey);
          if (abort.signal.aborted) {
            return;
          }
          windowKey = crypto.randomUUID();
          latest.current = snapshot;
          setConnection({snapshot, status: "connected"});
        } catch (failure) {
          if (abort.signal.aborted) {
            return;
          }
          setConnection({
            snapshot: latest.current,
            status: "failed",
            error: errorMessage(failure),
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

  /**
   * Saves a profile change, shows it at once and reports the outcome as a
   * toast. Resolves whether the save succeeded, so callers can drop drafts.
   *
   * Only the profile is replaced locally; the notification watermark stays
   * behind on purpose. Its new profile version is unknown here, and the
   * resulting refetch on the next sync is what brings children and metadata,
   * which a profile change can also affect.
   */
  const saveProfile = useCallback(
    async (update: ProfileUpdate, successMessage: string) => {
      let saved = false;
      await runAction(notify, async () => {
        await client.updateProfile(update);
        saved = true;
        const profile = await client.profile();
        if (latest.current) {
          const snapshot = {...latest.current, profile};
          latest.current = snapshot;
          setConnection((current) => ({...current, snapshot}));
        }
        return successMessage;
      });
      return saved;
    },
    [client, notify],
  );

  const {snapshot, status, error} = connection;
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
    saveProfile,
  };
}

export type SaveProfile = ReturnType<typeof useAgent>["saveProfile"];
