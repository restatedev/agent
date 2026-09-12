import type {
  McpAuthorizationRequest,
  McpServer,
  McpServerMutationResult,
  ToolDescriptor,
  UserAgent,
  UserProfile,
  WorkspaceSyncRequest,
} from "@restate-agents/types";
import {request} from "./agent-client";
import type {WorkspaceSyncResponse} from "./workspace-sync-types";

const write = <T>(operation: string, body: unknown) =>
  request<T>(`/api/user/${operation}`, {body});
export const userClient = {
  sync: (body: WorkspaceSyncRequest, signal: AbortSignal) =>
    request<WorkspaceSyncResponse>("/api/user/sync", {body, signal}),
  agentCompletions: (signal: AbortSignal) =>
    request<Array<{agentId: string; sequence: number}>>(
      "/api/user/agent-completions",
      {signal},
    ),
  profile: () => request<UserProfile>("/api/user/profile"),
  createAgent: (name: string, creationId: string) =>
    write<UserAgent>("agent", {name, creationId}),
  deleteAgent: (agentId: string) => write<boolean>("delete-agent", {agentId}),
  upsertConnection: (server: McpServer) =>
    write<McpServerMutationResult>("connection", server),
  removeConnection: (id: string) => write("remove-connection", {id}),
  disconnectConnection: (id: string) => write("disconnect-connection", {id}),
  discoverConnection: (id: string) =>
    write<ToolDescriptor[]>("discover-connection", {id}),
  beginAuthorization: (connectionId: string) =>
    write<McpAuthorizationRequest>("begin-authorization", {connectionId}),
  startAuthorization: (authRequestId: string) =>
    write<
      {status: "redirect"; authorizationUrl: string} | {status: "completed"}
    >("start-authorization", {authRequestId}),
  completeBearer: (authRequestId: string, accessToken: string) =>
    write<boolean>("complete-bearer", {authRequestId, accessToken}),
};
