// The User owns external accounts. Agents hold grants, never refresh tokens.
import type {
  EncryptedSecret,
  McpAuthorizationRequest,
  McpAuthorizationResolution,
  McpStoredOAuthState,
  McpTurnCredential,
  ResolvedMcpServer,
  UserAgent,
  UserIdentity,
  UserProfile,
} from "@restate-agents/types";
import {
  AgentDefinition,
  AgentNotificationsDefinition,
  UserDefinition,
  UserSessionDefinition,
} from "@restate-agents/types/services";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {discoverConnectionTools} from "../session/mcp-tools.js";

type Connection = {
  server: ResolvedMcpServer;
  credential?: McpTurnCredential;
  oauthState?: McpStoredOAuthState;
  tools: Array<{name: string; description: string}>;
};
type Waiter = {agentId: string; request: McpAuthorizationRequest};
type Authorization = {
  request: McpAuthorizationRequest;
  waiters: Waiter[];
  manual: boolean;
  expiresAt: number;
  flow?: EncryptedSecret;
};
const noRetention = {idempotencyRetention: 0, journalRetention: 0};

export const User = restate.implement(UserDefinition, {
  handlers: {
    *register(identity) {
      if (identity.userId !== key())
        throw new TerminalError("User identity key mismatch", {errorCode: 400});
      const existing = yield* restate.state().get<UserIdentity>("identity");
      if (
        existing &&
        (existing.issuer !== identity.issuer ||
          existing.subject !== identity.subject)
      )
        throw new TerminalError("Identity cannot be reassigned", {
          errorCode: 409,
        });
      restate.state().set("identity", identity);
    },
    *profile(): restate.Operation<UserProfile> {
      const identity = yield* restate
        .sharedState()
        .get<UserIdentity>("identity");
      if (!identity)
        throw new TerminalError("User is not registered", {errorCode: 404});
      return {
        identity,
        agents: yield* agents(),
        connections: (yield* connections()).map(publicConnection),
      };
    },
    *createAgent(agent) {
      if (yield* restate.state().get<boolean>(`deleted-agent:${agent.agentId}`))
        throw new TerminalError("Agent has been deleted", {errorCode: 410});
      if (!(yield* restate.state().get("identity")))
        throw new TerminalError("User is not registered", {errorCode: 404});
      const list = yield* agents();
      const existing = list.find((item) => item.agentId === agent.agentId);
      if (existing) return existing;
      if (list.length >= 100)
        throw new TerminalError("Limit of 100 agents reached", {
          errorCode: 400,
        });
      // initialize never calls back into User; ownership is immutable.
      yield* restate
        .client(AgentDefinition, agent.agentId)
        .initialize({ownerUserId: key(), name: agent.name});
      restate.state().set("agents", [...list, agent]);
      return agent;
    },
    *ownsAgent({agentId}) {
      return (yield* agents()).some((agent) => agent.agentId === agentId);
    },
    *deleteAgent({agentId}) {
      const list = yield* agents();
      if (!list.some((agent) => agent.agentId === agentId)) return false;
      restate.state().set(`deleted-agent:${agentId}`, true);
      restate.state().set(
        "agents",
        list.filter((agent) => agent.agentId !== agentId),
      );
      // Durable one-way cleanup avoids a User -> Agent -> User lock cycle.
      yield* restate
        .sendClient(AgentDefinition, agentId)
        .retire({ownerUserId: key()});
      const pending = yield* authorizations();
      for (const auth of pending) {
        auth.waiters = auth.waiters.filter(
          (waiter) => waiter.agentId !== agentId,
        );
      }
      restate.state().set(
        "authorizations",
        pending.filter((auth) => auth.manual || auth.waiters.length > 0),
      );
      return true;
    },
    *connections() {
      return (yield* connections()).map(publicConnection);
    },
    *upsertConnection(server) {
      const list = yield* connections();
      const index = list.findIndex((c) => c.server.id === server.id);
      if (index < 0 && list.length >= 32)
        return {
          accepted: false as const,
          error: "Limit of 32 connections reached",
        };
      const previous = list[index];
      const {revision: _, ...config} = previous?.server ?? {revision: 0};
      if (previous && JSON.stringify(config) === JSON.stringify(server))
        return {accepted: true as const, replaced: true, server};
      // A durable monotonic generation prevents delete/recreate reviving an old snapshot.
      const revision = yield* nextRevision();
      const connection: Connection = {server: {...server, revision}, tools: []};
      if (index < 0) list.push(connection);
      else list[index] = connection;
      restate.state().set("connections", list);
      yield* cancelConnection(server.id, "Connection configuration changed");
      yield* notifyAgents();
      return {accepted: true as const, replaced: index >= 0, server};
    },
    *removeConnection({id}) {
      const list = yield* connections();
      const retained = list.filter((c) => c.server.id !== id);
      if (retained.length === list.length) return {removed: false};
      restate.state().set("connections", retained);
      yield* cancelConnection(id, "Connection removed");
      yield* notifyAgents();
      return {removed: true};
    },
    *disconnectConnection({id}) {
      const list = yield* connections();
      const connection = list.find((c) => c.server.id === id);
      if (!connection) return;
      connection.server.revision = yield* nextRevision();
      delete connection.credential;
      delete connection.oauthState;
      connection.tools = [];
      restate.state().set("connections", list);
      yield* cancelConnection(id, "Connection disconnected");
      yield* notifyAgents();
    },
    *snapshot({agentId, tools}) {
      yield* requireAgent(agentId);
      const list = yield* connections();
      const selected = tools.mcp
        .filter((g) => g.tools.mode === "all" || g.tools.names.length > 0)
        .flatMap((g) => list.filter((c) => c.server.id === g.connectionId));
      return {
        servers: selected.map((c) => c.server),
        credentials: selected.flatMap((c) =>
          c.credential ? [c.credential] : [],
        ),
      };
    },
    *validateConnection({agentId, connectionId, revision}) {
      yield* requireAgent(agentId);
      return (yield* connections()).some(
        (c) => c.server.id === connectionId && c.server.revision === revision,
      );
    },
    *discoverConnection({id}) {
      const connection = (yield* connections()).find((c) => c.server.id === id);
      if (!connection)
        throw new TerminalError("Connection not found", {errorCode: 404});
      if (connection.server.auth.type !== "none" && !connection.credential)
        throw new TerminalError("Authorize this connection first", {
          errorCode: 409,
        });
      const tools = yield* discoverConnectionTools(
        connection.server,
        connection.credential,
        key(),
      );
      const saved = yield* restate
        .client(UserDefinition, key())
        .saveConnectionCatalog({
          id,
          revision: connection.server.revision,
          tools,
        });
      if (!saved)
        throw new TerminalError("Connection changed during discovery; retry", {
          errorCode: 409,
        });
      return tools;
    },
    *saveConnectionCatalog({id, revision, tools}) {
      const list = yield* connections(),
        connection = list.find(
          (c) => c.server.id === id && c.server.revision === revision,
        );
      if (!connection) return false;
      connection.tools = tools;
      restate.state().set("connections", list);
      return true;
    },
    *requestMcpAuthorization({agentId, request}) {
      yield* requireAgent(agentId);
      const connection = (yield* connections()).find(
        (c) => c.server.id === request.serverId,
      );
      if (
        !connection ||
        connection.server.auth.type !== request.authType ||
        connection.server.revision !== request.connectionRevision
      )
        return null;
      // Another agent may already have replaced the rejected token. Reuse it.
      if (
        connection.credential &&
        connection.credential.encryptedToken !== request.rejectedToken
      ) {
        yield* deliver(
          {agentId, request},
          {status: "authorized", credential: connection.credential},
        );
        return {...request, rejectedToken: undefined};
      }
      const authorization = yield* ensureAuthorization(
        connection,
        request,
        false,
      );
      if (
        !authorization.waiters.some(
          (w) =>
            w.agentId === agentId &&
            w.request.authRequestId === request.authRequestId &&
            w.request.turnId === request.turnId,
        )
      ) {
        authorization.waiters.push({
          agentId,
          request: {...request, rejectedToken: undefined},
        });
      }
      yield* saveAuthorization(authorization);
      return {
        ...request,
        rejectedToken: undefined,
        flowId: authorization.request.authRequestId,
      };
    },
    *beginAuthorization({connectionId, authRequestId}) {
      const connection = (yield* connections()).find(
        (c) => c.server.id === connectionId,
      );
      if (!connection || connection.server.auth.type === "none")
        throw new TerminalError("Connection does not require authorization", {
          errorCode: 400,
        });
      const authorization = yield* ensureAuthorization(
        connection,
        {
          authRequestId,
          serverId: connectionId,
          turnId: "account",
          authType: connection.server.auth.type,
          reason: "missing_credentials",
          connectionRevision: connection.server.revision,
        },
        true,
      );
      yield* saveAuthorization(authorization);
      return authorization.request;
    },
    *cancelMcpAuthorization({agentId, turnId, authRequestId}) {
      const list = yield* authorizations();
      for (const auth of list)
        auth.waiters = auth.waiters.filter(
          (w) =>
            !(
              w.agentId === agentId &&
              w.request.turnId === turnId &&
              w.request.authRequestId === authRequestId
            ),
        );
      restate.state().set(
        "authorizations",
        list.filter((a) => a.manual || a.waiters.length),
      );
    },
    *mcpAuthorizationContext({authRequestId}) {
      const authorization = yield* findAuthorization(authRequestId);
      if (
        !authorization ||
        authorization.expiresAt <= (yield* restate.date().now())
      )
        return null;
      const connection = (yield* connections()).find(
        (c) =>
          c.server.id === authorization.request.serverId &&
          c.server.revision === authorization.request.connectionRevision,
      );
      if (!connection) return null;
      return {
        request: authorization.request,
        server: connection.server,
        ...(connection.oauthState ? {oauthState: connection.oauthState} : {}),
        ...(authorization.flow ? {flow: authorization.flow} : {}),
      };
    },
    *saveMcpAuthorizationFlow({authRequestId, flow, expectedFlow}) {
      const authorization = yield* findAuthorization(authRequestId);
      if (
        !authorization ||
        authorization.expiresAt <= (yield* restate.date().now())
      )
        return false;
      if ((authorization.flow ?? null) !== expectedFlow) return false;
      authorization.flow = flow;
      yield* saveAuthorization(authorization);
      return true;
    },
    *completeMcpAuthorization({authRequestId, oauthState, expectedFlow}) {
      const authorization = yield* findAuthorization(authRequestId);
      if (!authorization || (authorization.flow ?? null) !== expectedFlow)
        return false;
      return yield* complete(
        authRequestId,
        {
          serverId: oauthState.serverId,
          encryptedToken: oauthState.encryptedToken,
        },
        "oauth",
        oauthState,
      );
    },
    *completeMcpBearerAuthorization({authRequestId, credential}) {
      return yield* complete(authRequestId, credential, "bearer");
    },
  },
  options: {
    enableLazyState: true,
    handlers: {
      profile: {shared: true, ...noRetention},
      ownsAgent: {shared: true, ...noRetention},
      connections: {shared: true, ...noRetention},
      snapshot: {shared: true, ...noRetention},
      validateConnection: {shared: true, ...noRetention},
      discoverConnection: {shared: true, ...noRetention},
      mcpAuthorizationContext: {shared: true, ...noRetention},
      saveMcpAuthorizationFlow: noRetention,
      completeMcpAuthorization: noRetention,
      completeMcpBearerAuthorization: noRetention,
    },
  },
});

function key(): string {
  const key = restate.handlerRequest().key;
  if (!key) throw new TerminalError("User key required", {errorCode: 400});
  return key;
}
function* agents(): restate.Operation<UserAgent[]> {
  return (yield* restate.sharedState().get<UserAgent[]>("agents")) ?? [];
}
function* connections(): restate.Operation<Connection[]> {
  return (yield* restate.sharedState().get<Connection[]>("connections")) ?? [];
}
function* authorizations(): restate.Operation<Authorization[]> {
  return (
    (yield* restate.sharedState().get<Authorization[]>("authorizations")) ?? []
  );
}
function* requireAgent(agentId: string) {
  if (!(yield* agents()).some((a) => a.agentId === agentId))
    throw new TerminalError("Agent does not belong to this user", {
      errorCode: 403,
    });
}
function publicConnection(c: Connection) {
  return {
    server: c.server,
    connected: c.server.auth.type === "none" || Boolean(c.credential),
    tools: c.tools,
  };
}
function* nextRevision(): restate.Operation<number> {
  const revision =
    ((yield* restate.state().get<number>("connection-revision")) ?? 0) + 1;
  restate.state().set("connection-revision", revision);
  return revision;
}
function* notifyAgents(): restate.Operation<void> {
  for (const agent of yield* agents())
    yield* restate
      .sendClient(AgentNotificationsDefinition, agent.agentId)
      .publish("profile");
}
function* deliver(
  waiter: Waiter,
  resolution: McpAuthorizationResolution,
): restate.Operation<void> {
  yield* restate
    .sendClient(AgentDefinition, waiter.agentId)
    .resolveMcpAuthorization({
      authRequestId: waiter.request.authRequestId,
      turnId: waiter.request.turnId,
      resolution,
    });
}
function* cancelConnection(
  id: string,
  reason: string,
): restate.Operation<void> {
  const list = yield* authorizations();
  for (const auth of list.filter((a) => a.request.serverId === id))
    for (const waiter of auth.waiters)
      yield* deliver(waiter, {status: "cancelled", reason});
  restate.state().set(
    "authorizations",
    list.filter((a) => a.request.serverId !== id),
  );
}
function* findAuthorization(
  id: string,
): restate.Operation<Authorization | undefined> {
  return (yield* authorizations()).find(
    (a) =>
      a.request.authRequestId === id ||
      a.waiters.some((w) => w.request.authRequestId === id),
  );
}
function* saveAuthorization(auth: Authorization): restate.Operation<void> {
  const list = yield* authorizations();
  const index = list.findIndex(
    (a) => a.request.authRequestId === auth.request.authRequestId,
  );
  if (index < 0) list.push(auth);
  else list[index] = auth;
  restate.state().set("authorizations", list);
}
function* ensureAuthorization(
  connection: Connection,
  request: McpAuthorizationRequest,
  manual: boolean,
): restate.Operation<Authorization> {
  const now = yield* restate.date().now();
  const existing = (yield* authorizations()).find(
    (a) => a.request.serverId === connection.server.id,
  );
  if (existing) {
    existing.manual ||= manual;
    existing.request.requestedScope =
      [
        ...new Set(
          [existing.request.requestedScope, request.requestedScope]
            .filter(Boolean)
            .join(" ")
            .split(/\s+/)
            .filter(Boolean),
        ),
      ].join(" ") || undefined;
    if (existing.expiresAt <= now) {
      // Keep waiting turns attached when the user retries an expired flow.
      existing.flow = undefined;
      existing.expiresAt = now + 15 * 60 * 1000;
    }
    return existing;
  }
  return {
    request: {...request, rejectedToken: undefined},
    waiters: [],
    manual,
    expiresAt: now + 15 * 60 * 1000,
  };
}
function* complete(
  id: string,
  credential: McpTurnCredential,
  type: "oauth" | "bearer",
  oauthState?: McpStoredOAuthState,
): restate.Operation<boolean> {
  const authorization = yield* findAuthorization(id);
  if (
    !authorization ||
    authorization.expiresAt <= (yield* restate.date().now()) ||
    authorization.request.authType !== type ||
    authorization.request.serverId !== credential.serverId
  )
    return false;
  const list = yield* connections();
  const connection = list.find(
    (c) =>
      c.server.id === credential.serverId &&
      c.server.revision === authorization.request.connectionRevision,
  );
  if (!connection) return false;
  connection.credential = credential;
  connection.oauthState = oauthState;
  restate.state().set("connections", list);
  restate.state().set(
    "authorizations",
    (yield* authorizations()).filter(
      (a) => a.request.authRequestId !== authorization.request.authRequestId,
    ),
  );
  for (const waiter of authorization.waiters)
    yield* deliver(waiter, {status: "authorized", credential});
  yield* notifyAgents();
  return true;
}

/** Key is SHA-256 of the opaque cookie; raw browser session tokens never enter Restate. */
export const UserSession = restate.implement(UserSessionDefinition, {
  handlers: {
    *create(session) {
      if (yield* restate.state().get("session"))
        throw new TerminalError("Session already exists", {errorCode: 409});
      restate.state().set("session", session);
    },
    *read() {
      const session = yield* restate
        .sharedState()
        .get<{userId: string; expiresAt: number}>("session");
      return session && session.expiresAt > (yield* restate.date().now())
        ? session
        : null;
    },
    *revoke() {
      restate.state().clear("session");
    },
  },
  options: {
    enableLazyState: true,
    handlers: {
      read: {shared: true, ...noRetention},
      create: noRetention,
      revoke: noRetention,
    },
  },
});
