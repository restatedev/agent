import {useCallback, useMemo} from "react";
import {
  type AgentClient,
  createAgentClient,
  type SequencedEntry,
} from "./agent-client";
import {useWorkspaceCache} from "./use-workspace";

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
export type AgentConnection = {agentId: string};
const emptyEntries: SequencedEntry[] = [];
const emptyApprovals: ApprovalRequest[] = [];
const emptyAuth: McpAuthorizationRequest[] = [];
const emptySchedules: ScheduledMessage[] = [];

/** Views subscribe to a retained workspace cache; they never start a poll. */
export function useAgent(connection: AgentConnection) {
  const {cache, state} = useWorkspaceCache();
  const id = connection.agentId;
  const client = useMemo(() => createAgentClient(id, cache), [id, cache]);
  const cached = Object.hasOwn(state.agents, id) ? state.agents[id] : undefined;
  const refreshProfile = useCallback(async () => {
    const profile = await client.profile();
    cache.patchAgent(id, {profile});
    return profile;
  }, [cache, client, id]);
  const refreshApprovals = useCallback(async () => {
    const approvals = await client.approvals();
    cache.patchAgent(id, {approvals});
    return approvals;
  }, [cache, client, id]);
  const refreshMcpAuthorizations = useCallback(async () => {
    const mcpAuthorizations = await client.mcpAuthorizations();
    cache.patchAgent(id, {mcpAuthorizations});
    return mcpAuthorizations;
  }, [cache, client, id]);
  const refreshSchedules = useCallback(async () => {
    const schedules = await client.schedules();
    cache.patchAgent(id, {schedules});
    return schedules;
  }, [cache, client, id]);
  const status =
    state.status === "connected" && !cached?.history
      ? "connecting"
      : state.status;
  return {
    client,
    entries: cached?.history?.entries ?? emptyEntries,
    profile: cached?.profile,
    approvals: cached?.approvals ?? emptyApprovals,
    mcpAuthorizations: cached?.mcpAuthorizations ?? emptyAuth,
    schedules: cached?.schedules ?? emptySchedules,
    connected: status === "connected",
    connectionStatus: status,
    connectionError: state.error,
    refreshProfile,
    refreshApprovals,
    refreshMcpAuthorizations,
    refreshSchedules,
  };
}
