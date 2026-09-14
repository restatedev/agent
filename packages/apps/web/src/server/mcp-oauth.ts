import "server-only";

import {timingSafeEqual} from "node:crypto";
import {
  auth,
  computeScopeUnion,
  isStrictScopeSuperset,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {
  openMcpOAuthFlow,
  openMcpOAuthState,
  sealMcpOAuthFlow,
  sealMcpOAuthState,
} from "@restate-agents/secrets";
import type {
  EncryptedSecret,
  McpAuthorizationContext,
  McpOAuthFlow,
  McpOAuthState,
} from "@restate-agents/types";
import {publicUrl} from "./public-url";
import {BffError, type userClient} from "./restate";
import {requireUser} from "./user-auth";

export type McpOAuthStartResult =
  | {status: "redirect"; authorizationUrl: string}
  | {status: "completed"};

type McpOAuthCallbackTarget = {
  userId: string;
  sessionId: string;
  agentId?: string;
  authRequestId: string;
};
type OAuthContext = Omit<
  NonNullable<McpAuthorizationContext>,
  "oauthState" | "flow"
> & {
  oauthState?: McpOAuthState;
  flow?: McpOAuthFlow;
  storedFlow: EncryptedSecret | null;
};

/** Starts discovery/registration/authorization for one pending Agent request. */
export async function startMcpOAuth(
  request: Request,
  agentId: string | undefined,
  authRequestId: string,
): Promise<McpOAuthStartResult> {
  const user = await requireUser();
  if (agentId && !(await user.client.ownsAgent(agentId)))
    throw new BffError(404, "Agent not found");
  const client = user.client;
  const context = await requiredContext(client, user.userId, authRequestId);
  const redirectUrl = callbackUrl(request);
  const provider = OAuthProvider.start(
    context,
    redirectUrl,
    clientMetadataUrl(request),
    callbackState({
      userId: user.userId,
      sessionId: user.sessionId,
      agentId,
      authRequestId: context.request.authRequestId,
    }),
  );
  const scope = authorizationScope(context);

  const result = await auth(provider, {
    serverUrl: context.server.url,
    ...(scope ? {scope} : {}),
    forceReauthorization:
      context.request.reason === "insufficient_scope" &&
      isStrictScopeSuperset(scope, context.oauthState?.tokens.scope),
  });
  return finishOrPersist(client, user.userId, context, provider, result);
}

/** Validates the redirect and exchanges its code for the waiting Turn. */
export async function finishMcpOAuth(
  request: Request,
  target: McpOAuthCallbackTarget,
): Promise<McpOAuthStartResult> {
  const user = await requireUser();
  if (user.userId !== target.userId || user.sessionId !== target.sessionId)
    throw new BffError(403, "This OAuth flow belongs to another login session");
  if (target.agentId && !(await user.client.ownsAgent(target.agentId)))
    throw new BffError(404, "Agent not found");
  const client = user.client;
  const context = await requiredContext(
    client,
    user.userId,
    target.authRequestId,
  );
  if (!context.flow) {
    throw new BffError(409, "This OAuth flow has not been started");
  }

  const parameters = new URL(request.url).searchParams;
  const returnedState = parameters.get("state");
  if (!returnedState || !sameSecret(returnedState, context.flow.state)) {
    throw new BffError(400, "OAuth state validation failed");
  }
  if (parameters.has("error")) {
    throw new BffError(400, "OAuth authorization was not completed");
  }
  const authorizationCode = parameters.get("code");
  if (!authorizationCode) {
    throw new BffError(400, "OAuth callback did not include a code");
  }

  const provider = OAuthProvider.resume(
    context.flow,
    clientMetadataUrl(request),
  );
  const scope = authorizationScope(context);
  const result = await auth(provider, {
    serverUrl: context.server.url,
    authorizationCode,
    ...(parameters.get("iss") ? {iss: parameters.get("iss") ?? undefined} : {}),
    ...(scope ? {scope} : {}),
    forceReauthorization:
      context.request.reason === "insufficient_scope" &&
      isStrictScopeSuperset(scope, context.oauthState?.tokens.scope),
  });
  return finishOrPersist(client, user.userId, context, provider, result);
}

/** Reads the routing envelope; finishMcpOAuth subsequently validates it. */
export function mcpOAuthCallbackTarget(
  request: Request,
): McpOAuthCallbackTarget {
  const state = new URL(request.url).searchParams.get("state");
  if (!state) {
    throw new BffError(400, "OAuth callback did not include state");
  }
  try {
    const value = JSON.parse(
      Buffer.from(state, "base64url").toString(),
    ) as McpOAuthCallbackTarget & {nonce: string};
    if (
      typeof value.userId !== "string" ||
      typeof value.sessionId !== "string" ||
      typeof value.authRequestId !== "string" ||
      !value.authRequestId ||
      typeof value.nonce !== "string" ||
      (value.agentId !== undefined && typeof value.agentId !== "string")
    )
      throw new Error("invalid envelope");
    return {
      userId: value.userId,
      sessionId: value.sessionId,
      authRequestId: value.authRequestId,
      ...(value.agentId ? {agentId: value.agentId} : {}),
    };
  } catch {
    throw new BffError(400, "OAuth callback state is malformed");
  }
}

function authorizationScope(context: OAuthContext): string | undefined {
  return computeScopeUnion(
    context.oauthState?.tokens.scope,
    context.request.requestedScope,
  );
}

async function requiredContext(
  client: ReturnType<typeof userClient>,
  userId: string,
  authRequestId: string,
): Promise<OAuthContext> {
  const context = await client.mcpAuthorizationContext(authRequestId);
  if (!context) {
    throw new BffError(404, "MCP authorization request is no longer pending");
  }
  if (context.server.auth.type !== "oauth") {
    throw new BffError(409, "MCP server is not configured for OAuth");
  }
  return {
    ...context,
    storedFlow: context.flow ?? null,
    oauthState: context.oauthState
      ? openMcpOAuthState(userId, context.oauthState)
      : undefined,
    flow: context.flow
      ? openMcpOAuthFlow(
          userId,
          context.server.id,
          context.request.authRequestId,
          context.flow,
        )
      : undefined,
  };
}

async function finishOrPersist(
  client: ReturnType<typeof userClient>,
  userId: string,
  context: OAuthContext,
  provider: OAuthProvider,
  result: "AUTHORIZED" | "REDIRECT",
): Promise<McpOAuthStartResult> {
  if (result === "AUTHORIZED") {
    const completed = await client.completeMcpAuthorization(
      context.request.authRequestId,
      sealMcpOAuthState(userId, provider.oauthState(context.server.id)),
      context.storedFlow,
    );
    if (!completed) {
      throw new BffError(
        409,
        "The waiting Turn no longer accepts authorization",
      );
    }
    return {status: "completed"};
  }

  const authorizationUrl = provider.authorizationUrl;
  if (!authorizationUrl) {
    throw new BffError(
      502,
      "OAuth provider did not produce an authorization URL",
    );
  }
  const saved = await client.saveMcpAuthorizationFlow(
    context.request.authRequestId,
    sealMcpOAuthFlow(
      userId,
      context.server.id,
      context.request.authRequestId,
      provider.flow(),
    ),
    context.storedFlow,
  );
  if (!saved) {
    throw new BffError(409, "The waiting Turn no longer accepts authorization");
  }
  return {status: "redirect", authorizationUrl};
}

function callbackUrl(request: Request): string {
  return publicUrl(request, "/api/mcp-oauth/callback").toString();
}

function clientMetadataUrl(request: Request): string | undefined {
  const url = publicUrl(request, "/api/mcp-oauth/client-metadata");
  return url.protocol === "https:" ? url.toString() : undefined;
}

function callbackState(target: McpOAuthCallbackTarget): string {
  return Buffer.from(
    JSON.stringify({...target, nonce: crypto.randomUUID()}),
  ).toString("base64url");
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

/** In-memory SDK adapter whose complete state is persisted by the User VO. */
class OAuthProvider implements OAuthClientProvider {
  authorizationUrl?: string;
  private codeVerifierValue?: string;
  private tokensValue?: StoredOAuthTokens;
  private clientInformationValue?: StoredOAuthClientInformation;
  private discoveryStateValue?: OAuthDiscoveryState;

  private constructor(
    readonly redirectUrl: string,
    readonly clientMetadataUrl: string | undefined,
    private readonly stateValue: string,
  ) {}

  static start(
    context: OAuthContext,
    redirectUrl: string,
    metadataUrl: string | undefined,
    state: string,
  ): OAuthProvider {
    const provider = new OAuthProvider(redirectUrl, metadataUrl, state);
    if (context.oauthState?.redirectUrl === redirectUrl) {
      provider.tokensValue = context.oauthState.tokens as StoredOAuthTokens;
      provider.clientInformationValue = context.oauthState.clientInformation as
        | StoredOAuthClientInformation
        | undefined;
      provider.discoveryStateValue = context.oauthState.discoveryState as
        | OAuthDiscoveryState
        | undefined;
    }
    return provider;
  }

  static resume(
    flow: McpOAuthFlow,
    metadataUrl: string | undefined,
  ): OAuthProvider {
    const provider = new OAuthProvider(
      flow.redirectUrl,
      metadataUrl,
      flow.state,
    );
    provider.codeVerifierValue = flow.codeVerifier;
    provider.tokensValue = flow.tokens as StoredOAuthTokens | undefined;
    provider.clientInformationValue = flow.clientInformation as
      | StoredOAuthClientInformation
      | undefined;
    provider.discoveryStateValue = flow.discoveryState as
      | OAuthDiscoveryState
      | undefined;
    return provider;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Restate Agent",
      redirect_uris: [this.redirectUrl],
      // Attio requires this explicitly during dynamic client registration.
      response_types: ["code"],
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(
    _context?: OAuthClientInformationContext,
  ): StoredOAuthClientInformation | undefined {
    return this.clientInformationValue;
  }

  saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    _context?: OAuthClientInformationContext,
  ): void {
    this.clientInformationValue = clientInformation;
  }

  tokens(
    _context?: OAuthClientInformationContext,
  ): StoredOAuthTokens | undefined {
    return this.tokensValue;
  }

  saveTokens(
    tokens: StoredOAuthTokens,
    _context?: OAuthClientInformationContext,
  ): void {
    this.tokensValue = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl.toString();
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) {
      throw new Error("OAuth code verifier is unavailable");
    }
    return this.codeVerifierValue;
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    this.discoveryStateValue = discoveryState;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discoveryStateValue;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    if (scope === "all" || scope === "client") {
      this.clientInformationValue = undefined;
    }
    if (scope === "all" || scope === "tokens") {
      this.tokensValue = undefined;
    }
    if (scope === "all" || scope === "verifier") {
      this.codeVerifierValue = undefined;
    }
    if (scope === "all" || scope === "discovery") {
      this.discoveryStateValue = undefined;
    }
  }

  flow(): McpOAuthFlow {
    if (!this.codeVerifierValue) {
      throw new BffError(502, "OAuth provider did not produce a code verifier");
    }
    return {
      redirectUrl: this.redirectUrl,
      state: this.stateValue,
      codeVerifier: this.codeVerifierValue,
      ...(this.tokensValue ? {tokens: this.tokensValue} : {}),
      ...(this.clientInformationValue
        ? {clientInformation: this.clientInformationValue}
        : {}),
      ...(this.discoveryStateValue
        ? {discoveryState: this.discoveryStateValue}
        : {}),
    } as McpOAuthFlow;
  }

  oauthState(serverId: string): McpOAuthState {
    if (!this.tokensValue) {
      throw new BffError(502, "OAuth provider did not produce credentials");
    }
    return {
      serverId,
      redirectUrl: this.redirectUrl,
      tokens: this.tokensValue,
      ...(this.clientInformationValue
        ? {clientInformation: this.clientInformationValue}
        : {}),
      ...(this.discoveryStateValue
        ? {discoveryState: this.discoveryStateValue}
        : {}),
    } as McpOAuthState;
  }
}
