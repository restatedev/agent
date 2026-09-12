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
            const initial = await client.snapshot({signal: abort.signal});
            if (abort.signal.aborted) return;
            setProfile(initial.profile);
            setApprovals(initial.approvals);
            setMcpAuthorizations(initial.mcpAuthorizations);
            setSchedules(initial.schedules);
            setEntries(initial.history.entries);
            nextSequence = initial.history.nextSequence;
            notification = initial.notification;
          }
          if (abort.signal.aborted) return;
          setConnectionState({
            agentId: connection.agentId,
            status: "connected",
          });

          const next = await client.sync(notification, nextSequence, {
            idempotencyKey: watchKey,
            signal: abort.signal,
          });
          if (abort.signal.aborted) return;

          if (next.profile !== undefined) setProfile(next.profile);
          if (next.approvals !== undefined) setApprovals(next.approvals);
          if (next.mcpAuthorizations !== undefined)
            setMcpAuthorizations(next.mcpAuthorizations);
          if (next.schedules !== undefined) setSchedules(next.schedules);
          if (next.history !== undefined) {
            const page = next.history;
            setEntries((current) => [...current, ...page.entries]);
            nextSequence = page.nextSequence;
          }
          notification = next.notification;
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
  }, [client, connection.agentId]);

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
