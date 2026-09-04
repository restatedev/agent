import {useCallback, useEffect, useMemo, useState} from "react";
import {
  type AgentClient,
  createAgentClient,
  type SequencedEntry,
} from "./agent-client";

export type AgentProfile = Awaited<ReturnType<AgentClient["profile"]>>;
export type ApprovalRequest = Awaited<
  ReturnType<AgentClient["approvals"]>
>[number];
export type McpAuthorizationRequest = Awaited<
  ReturnType<AgentClient["mcpAuthorizations"]>
>[number];
export type ScheduledMessage = Awaited<
  ReturnType<AgentClient["schedules"]>
>[number];

export type AgentConnection = {
  agentId: string;
};

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      {once: true},
    );
  });
}

export function useAgent(connection: AgentConnection) {
  const client = useMemo(
    () => createAgentClient(connection.agentId),
    [connection.agentId],
  );
  const [entries, setEntries] = useState<SequencedEntry[]>([]);
  const [profile, setProfile] = useState<AgentProfile>();
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [mcpAuthorizations, setMcpAuthorizations] = useState<
    McpAuthorizationRequest[]
  >([]);
  const [schedules, setSchedules] = useState<ScheduledMessage[]>([]);
  const [connectionState, setConnectionState] = useState<{
    agentId: string;
    status: "connecting" | "connected" | "failed";
    error?: string;
  }>({agentId: connection.agentId, status: "connecting"});

  const refreshProfile = useCallback(async () => {
    const next = await client.profile();
    setProfile(next);
    return next;
  }, [client]);

  const refreshApprovals = useCallback(async () => {
    const next = await client.approvals();
    setApprovals(next);
    return next;
  }, [client]);

  const refreshMcpAuthorizations = useCallback(async () => {
    const next = await client.mcpAuthorizations();
    setMcpAuthorizations(next);
    return next;
  }, [client]);

  const refreshSchedules = useCallback(async () => {
    const next = await client.schedules();
    setSchedules(next);
    return next;
  }, [client]);

  useEffect(() => {
    const abort = new AbortController();
    let nextSequence = 1;
    setEntries([]);
    setProfile(undefined);
    setApprovals([]);
    setMcpAuthorizations([]);
    setSchedules([]);
    setConnectionState({agentId: connection.agentId, status: "connecting"});

    async function poll() {
      let notification:
        | Awaited<ReturnType<AgentClient["notifications"]>>
        | undefined;
      let watchKey = crypto.randomUUID();

      while (!abort.signal.aborted) {
        try {
          if (!notification) {
            const initialNotification = await client.notifications();
            await Promise.all([
              refreshProfile(),
              refreshApprovals(),
              refreshMcpAuthorizations(),
              refreshSchedules(),
            ]);
            notification = initialNotification;
          }
          while (!abort.signal.aborted) {
            const page = await client.history(nextSequence, 100);
            if (page.entries.length === 0) break;
            nextSequence = page.nextSequence;
            setEntries((current) => [...current, ...page.entries]);
          }
          if (abort.signal.aborted) return;
          setConnectionState({
            agentId: connection.agentId,
            status: "connected",
          });

          const next = await client.watchNotifications(
            notification.revision,
            25,
            {idempotencyKey: watchKey, signal: abort.signal},
          );
          if (abort.signal.aborted) return;

          const refreshes: Promise<unknown>[] = [];
          if (next.versions.profile > notification.versions.profile) {
            refreshes.push(refreshProfile());
          }
          if (next.versions.approvals > notification.versions.approvals) {
            refreshes.push(refreshApprovals());
          }
          if (next.versions.mcpAuth > notification.versions.mcpAuth) {
            refreshes.push(refreshMcpAuthorizations());
          }
          if (next.versions.schedules > notification.versions.schedules) {
            refreshes.push(refreshSchedules());
          }
          await Promise.all(refreshes);
          notification = next;
          watchKey = crypto.randomUUID();
        } catch (error) {
          if (abort.signal.aborted) return;
          setConnectionState({
            agentId: connection.agentId,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
          await abortableDelay(2_000, abort.signal);
          if (!abort.signal.aborted) {
            setConnectionState({
              agentId: connection.agentId,
              status: "connecting",
            });
          }
        }
      }
    }

    void poll();
    return () => abort.abort();
  }, [
    client,
    connection.agentId,
    refreshApprovals,
    refreshMcpAuthorizations,
    refreshProfile,
    refreshSchedules,
  ]);

  const activeConnectionState =
    connectionState.agentId === connection.agentId
      ? connectionState
      : {
          agentId: connection.agentId,
          status: "connecting" as const,
          error: undefined,
        };

  return {
    client,
    entries,
    profile,
    approvals,
    mcpAuthorizations,
    schedules,
    connected: activeConnectionState.status === "connected",
    connectionError: activeConnectionState.error,
    connectionStatus: activeConnectionState.status,
    refreshProfile,
    refreshApprovals,
    refreshMcpAuthorizations,
    refreshSchedules,
  };
}
