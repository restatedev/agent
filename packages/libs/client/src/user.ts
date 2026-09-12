import type {
  AgentTools,
  EncryptedSecret,
  McpAuthorizationRequest,
  McpServer,
  McpStoredOAuthState,
  McpTurnCredential,
  UserAgent,
  UserIdentity,
} from "@restate-agents/types";
import {
  UserIngressDefinition,
  type UserIngressHandlers,
  UserSessionIngressDefinition,
  type UserSessionIngressHandlers,
} from "@restate-agents/types/targets";
import {connect, rpc, serde} from "@restatedev/restate-sdk-clients";

type ConnectionOptions = {ingressUrl: string; headers?: Record<string, string>};
export function createUserClient({
  userId,
  ...options
}: ConnectionOptions & {userId: string}) {
  const user = connect({
    url: options.ingressUrl,
    headers: options.headers,
  }).objectClient<UserIngressHandlers>(UserIngressDefinition, userId);
  return {
    register: (identity: UserIdentity) => user.register(identity),
    profile: () => user.profile(rpc.opts({input: serde.empty})),
    connections: () => user.connections(rpc.opts({input: serde.empty})),
    createAgent: (agent: UserAgent) => user.createAgent(agent),
    deleteAgent: (agentId: string) => user.deleteAgent({agentId}),
    ownsAgent: (agentId: string) => user.ownsAgent({agentId}),
    upsertConnection: (server: McpServer) => user.upsertConnection(server),
    removeConnection: (id: string) => user.removeConnection({id}),
    disconnectConnection: (id: string) => user.disconnectConnection({id}),
    discoverConnection: (id: string) => user.discoverConnection({id}),
    snapshot: (agentId: string, tools: AgentTools) =>
      user.snapshot({agentId, tools}),
    beginAuthorization: (connectionId: string, authRequestId: string) =>
      user.beginAuthorization({connectionId, authRequestId}),
    requestMcpAuthorization: (
      agentId: string,
      request: McpAuthorizationRequest,
    ) => user.requestMcpAuthorization({agentId, request}),
    mcpAuthorizationContext: (authRequestId: string) =>
      user.mcpAuthorizationContext({authRequestId}),
    saveMcpAuthorizationFlow: (
      authRequestId: string,
      flow: EncryptedSecret,
      expectedFlow: EncryptedSecret | null,
    ) => user.saveMcpAuthorizationFlow({authRequestId, flow, expectedFlow}),
    completeMcpAuthorization: (
      authRequestId: string,
      oauthState: McpStoredOAuthState,
      expectedFlow: EncryptedSecret | null,
    ) =>
      user.completeMcpAuthorization({authRequestId, oauthState, expectedFlow}),
    completeMcpBearerAuthorization: (
      authRequestId: string,
      credential: McpTurnCredential,
    ) => user.completeMcpBearerAuthorization({authRequestId, credential}),
  };
}
export function createUserSessionClient({
  sessionId,
  ...options
}: ConnectionOptions & {sessionId: string}) {
  const session = connect({
    url: options.ingressUrl,
    headers: options.headers,
  }).objectClient<UserSessionIngressHandlers>(
    UserSessionIngressDefinition,
    sessionId,
  );
  return {
    create: (userId: string, expiresAt: number) =>
      session.create({userId, expiresAt}),
    read: () => session.read(rpc.opts({input: serde.empty})),
    revoke: () => session.revoke(rpc.opts({input: serde.empty})),
  };
}
