// Private MCP OAuth/bearer state and pending user-interaction requests for one
// Agent virtual object. This state is durable, but is intentionally not part
// of the public Agent profile.

import type {
  McpAuthorizationContext,
  McpAuthorizationRequest,
  McpAuthorizationResolution,
  McpBearerCredential,
  McpOAuthFlow,
  McpOAuthState,
  McpServer,
  McpTurnCredential,
} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import {mcpAuthorizationSignalName} from "../internal-types.js";

const OAUTH_STATES = "mcp/oauth-states";
const BEARER_CREDENTIALS = "mcp/bearer-credentials";
const REQUESTS = "mcp/authorization-requests";
const FLOWS = "mcp/oauth-flows";

type StoredFlow = {authRequestId: string; flow: McpOAuthFlow};

/** Returns the private OAuth state owned by this Agent. */
export function* oauthStates(): restate.Operation<McpOAuthState[]> {
  return (
    (yield* restate.sharedState().get<McpOAuthState[]>(OAUTH_STATES)) ?? []
  );
}

/** Returns user-supplied bearer credentials owned privately by this Agent. */
export function* bearerCredentials(): restate.Operation<McpBearerCredential[]> {
  return (
    (yield* restate
      .sharedState()
      .get<McpBearerCredential[]>(BEARER_CREDENTIALS)) ?? []
  );
}

/** Returns the user-visible authorization requests currently awaiting action. */
export function* requests(): restate.Operation<McpAuthorizationRequest[]> {
  return (
    (yield* restate.sharedState().get<McpAuthorizationRequest[]>(REQUESTS)) ??
    []
  );
}

/** Registers a request, coalescing concurrent requests for the same server. */
export function* register(
  request: McpAuthorizationRequest,
): restate.Operation<McpAuthorizationRequest | undefined> {
  const pending = yield* requests();
  const byServer = pending.find(
    (candidate) =>
      candidate.turnId === request.turnId &&
      candidate.serverId === request.serverId,
  );
  if (byServer) {
    return byServer;
  }

  const conflictingId = pending.some(
    (candidate) => candidate.authRequestId === request.authRequestId,
  );
  if (conflictingId) {
    return undefined;
  }

  pending.push(request);
  restate.state().set(REQUESTS, pending);
  return request;
}

/** Removes one abandoned request and its private redirect state. */
export function* cancel({
  authRequestId,
  turnId,
}: {
  authRequestId: string;
  turnId: string;
}): restate.Operation<McpAuthorizationRequest | undefined> {
  const pending = yield* requests();
  const request = pending.find(
    (candidate) =>
      candidate.authRequestId === authRequestId && candidate.turnId === turnId,
  );
  if (!request) {
    return undefined;
  }

  storeRequests(
    pending.filter(
      (candidate) =>
        candidate.authRequestId !== authRequestId ||
        candidate.turnId !== turnId,
    ),
  );
  yield* removeFlow(authRequestId);
  return request;
}

/** Removes every pending request belonging to a terminal Turn. */
export function* clearTurn(
  turnId: string,
): restate.Operation<McpAuthorizationRequest[]> {
  const pending = yield* requests();
  const removed = pending.filter((request) => request.turnId === turnId);
  if (removed.length === 0) {
    return [];
  }

  storeRequests(pending.filter((request) => request.turnId !== turnId));
  for (const {authRequestId} of removed) {
    yield* removeFlow(authRequestId);
  }
  return removed;
}

/** Cancels every authorization waiter belonging to an interrupted Turn. */
export function* cancelTurn(
  turnId: string,
  reason: string,
): restate.Operation<McpAuthorizationRequest[]> {
  const removed = yield* clearTurn(turnId);
  for (const request of removed) {
    restate
      .invocation(request.turnId)
      .signal<McpAuthorizationResolution>(
        mcpAuthorizationSignalName(request.authRequestId),
      )
      .resolve({status: "cancelled", reason});
  }
  return removed;
}

/**
 * Clears credentials and pending flows bound to a removed or materially
 * changed server. Active waiters receive a cancellation signal.
 */
export function* invalidateServer(
  serverId: string,
  reason: string,
): restate.Operation<boolean> {
  const storedStates = yield* oauthStates();
  const retainedStates = storedStates.filter(
    (oauthState) => oauthState.serverId !== serverId,
  );
  const changed = retainedStates.length !== storedStates.length;
  storeOAuthStates(retainedStates);

  const storedBearerCredentials = yield* bearerCredentials();
  const retainedBearerCredentials = storedBearerCredentials.filter(
    (credential) => credential.serverId !== serverId,
  );
  const bearerChanged =
    retainedBearerCredentials.length !== storedBearerCredentials.length;
  storeBearerCredentials(retainedBearerCredentials);

  const pending = yield* requests();
  const removed = pending.filter((request) => request.serverId === serverId);
  if (removed.length === 0) {
    return changed || bearerChanged;
  }

  storeRequests(pending.filter((request) => request.serverId !== serverId));
  for (const request of removed) {
    yield* removeFlow(request.authRequestId);
    restate
      .invocation(request.turnId)
      .signal<McpAuthorizationResolution>(
        mcpAuthorizationSignalName(request.authRequestId),
      )
      .resolve({status: "cancelled", reason});
  }
  return true;
}

/** Returns the private BFF context needed to start or finish one OAuth flow. */
export function* context(
  authRequestId: string,
  server: McpServer | undefined,
): restate.Operation<McpAuthorizationContext> {
  if (!server) {
    return null;
  }
  const pending = yield* requests();
  const request = pending.find(
    (candidate) => candidate.authRequestId === authRequestId,
  );
  if (!request || request.serverId !== server.id) {
    return null;
  }

  const storedStates = yield* oauthStates();
  const flows = yield* readFlows();
  const oauthState = storedStates.find(
    (candidate) => candidate.serverId === server.id,
  );
  const flow = flows.find(
    (candidate) => candidate.authRequestId === authRequestId,
  )?.flow;
  return {
    request,
    server,
    ...(oauthState ? {oauthState} : {}),
    ...(flow ? {flow} : {}),
  };
}

/** Stores redirect-round-trip state only while its request remains pending. */
export function* saveFlow(
  authRequestId: string,
  flow: McpOAuthFlow,
): restate.Operation<boolean> {
  const pending = yield* requests();
  if (!pending.some((request) => request.authRequestId === authRequestId)) {
    return false;
  }

  const flows = yield* readFlows();
  const index = flows.findIndex(
    (candidate) => candidate.authRequestId === authRequestId,
  );
  const stored = {authRequestId, flow};
  if (index < 0) {
    flows.push(stored);
  } else {
    flows[index] = stored;
  }
  restate.state().set(FLOWS, flows);
  return true;
}

/**
 * Atomically persists the private OAuth state, retires the request, and
 * resumes the originating Turn with only its current access token.
 */
export function* complete(
  authRequestId: string,
  oauthState: McpOAuthState,
  activeTurnId?: string,
): restate.Operation<McpAuthorizationRequest | undefined> {
  const pending = yield* requests();
  const request = pending.find(
    (candidate) => candidate.authRequestId === authRequestId,
  );
  if (
    request?.authType !== "oauth" ||
    request.turnId !== activeTurnId ||
    request.serverId !== oauthState.serverId
  ) {
    return undefined;
  }

  const storedStates = yield* oauthStates();
  const index = storedStates.findIndex(
    (candidate) => candidate.serverId === oauthState.serverId,
  );
  if (index < 0) {
    storedStates.push(oauthState);
  } else {
    storedStates[index] = oauthState;
  }
  storeOAuthStates(storedStates);
  storeRequests(
    pending.filter((candidate) => candidate.authRequestId !== authRequestId),
  );
  yield* removeFlow(authRequestId);

  const credential: McpTurnCredential = {
    serverId: oauthState.serverId,
    accessToken: oauthState.tokens.access_token,
  };
  restate
    .invocation(request.turnId)
    .signal<McpAuthorizationResolution>(
      mcpAuthorizationSignalName(authRequestId),
    )
    .resolve({status: "authorized", credential});
  return request;
}

/**
 * Stores a user-supplied bearer token and resumes its waiting Turn without
 * exposing that token through profile or authorization reads.
 */
export function* completeBearer(
  authRequestId: string,
  accessToken: string,
  activeTurnId?: string,
): restate.Operation<McpAuthorizationRequest | undefined> {
  const pending = yield* requests();
  const request = pending.find(
    (candidate) => candidate.authRequestId === authRequestId,
  );
  if (request?.authType !== "bearer" || request.turnId !== activeTurnId) {
    return undefined;
  }

  const credentials = yield* bearerCredentials();
  const credential: McpBearerCredential = {
    serverId: request.serverId,
    accessToken,
  };
  const index = credentials.findIndex(
    (candidate) => candidate.serverId === request.serverId,
  );
  if (index < 0) {
    credentials.push(credential);
  } else {
    credentials[index] = credential;
  }
  storeBearerCredentials(credentials);
  storeRequests(
    pending.filter((candidate) => candidate.authRequestId !== authRequestId),
  );
  yield* removeFlow(authRequestId);

  restate
    .invocation(request.turnId)
    .signal<McpAuthorizationResolution>(
      mcpAuthorizationSignalName(authRequestId),
    )
    .resolve({status: "authorized", credential});
  return request;
}

function* readFlows(): restate.Operation<StoredFlow[]> {
  return (yield* restate.sharedState().get<StoredFlow[]>(FLOWS)) ?? [];
}

function* removeFlow(authRequestId: string): restate.Operation<void> {
  const flows = yield* readFlows();
  const remaining = flows.filter(
    (candidate) => candidate.authRequestId !== authRequestId,
  );
  if (remaining.length !== flows.length) {
    storeFlows(remaining);
  }
}

function storeOAuthStates(oauthStates: McpOAuthState[]): void {
  if (oauthStates.length === 0) {
    restate.state().clear(OAUTH_STATES);
  } else {
    restate.state().set(OAUTH_STATES, oauthStates);
  }
}

function storeBearerCredentials(credentials: McpBearerCredential[]): void {
  if (credentials.length === 0) {
    restate.state().clear(BEARER_CREDENTIALS);
  } else {
    restate.state().set(BEARER_CREDENTIALS, credentials);
  }
}

function storeRequests(requests: McpAuthorizationRequest[]): void {
  if (requests.length === 0) {
    restate.state().clear(REQUESTS);
  } else {
    restate.state().set(REQUESTS, requests);
  }
}

function storeFlows(flows: StoredFlow[]): void {
  if (flows.length === 0) {
    restate.state().clear(FLOWS);
  } else {
    restate.state().set(FLOWS, flows);
  }
}
