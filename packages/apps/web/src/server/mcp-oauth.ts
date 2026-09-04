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
import type {
  McpAuthorizationContext,
  McpOAuthFlow,
  McpOAuthState,
} from "@restate-agents/types";
import {agentClient, BffError} from "./restate";

export type McpOAuthStartResult =
  | {status: "redirect"; authorizationUrl: string}
  | {status: "completed"};

type McpOAuthCallbackTarget = {agentId: string; authRequestId: string};

/** Starts discovery/registration/authorization for one pending Agent request. */
export async function startMcpOAuth(
  request: Request,
  agentId: string,
  authRequestId: string,
): Promise<McpOAuthStartResult> {
  const client = agentClient(agentId);
  const context = await requiredContext(client, authRequestId);
  const redirectUrl = callbackUrl(request.url);
  const provider = OAuthProvider.start(
    context,
    redirectUrl,
    clientMetadataUrl(request.url),
    callbackState(agentId, authRequestId),
  );
  const scope = authorizationScope(context);

  const result = await auth(provider, {
    serverUrl: context.server.url,
    ...(scope ? {scope} : {}),
    forceReauthorization:
      context.request.reason === "insufficient_scope" &&
      isStrictScopeSuperset(scope, context.oauthState?.tokens.scope),
  });
  return finishOrPersist(client, context, provider, result);
}

/** Validates the redirect and exchanges its code for the waiting Turn. */
export async function finishMcpOAuth(
  request: Request,
  target: McpOAuthCallbackTarget,
): Promise<McpOAuthStartResult> {
  const {agentId, authRequestId} = target;
  const client = agentClient(agentId);
  const context = await requiredContext(client, authRequestId);
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
    clientMetadataUrl(request.url),
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
  return finishOrPersist(client, context, provider, result);
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
    const value = JSON.parse(Buffer.from(state, "base64url").toString()) as {
      agentId?: unknown;
      authRequestId?: unknown;
      nonce?: unknown;
    };
    if (
      typeof value.agentId !== "string" ||
      !value.agentId ||
      value.agentId.length > 256 ||
      typeof value.authRequestId !== "string" ||
      !value.authRequestId ||
      typeof value.nonce !== "string" ||
      !value.nonce
    ) {
      throw new Error("invalid routing envelope");
    }
    return {agentId: value.agentId, authRequestId: value.authRequestId};
  } catch {
    throw new BffError(400, "OAuth callback state is malformed");
  }
}

function authorizationScope(
  context: NonNullable<McpAuthorizationContext>,
): string | undefined {
  return computeScopeUnion(
    context.oauthState?.tokens.scope,
    context.request.requestedScope,
  );
}

async function requiredContext(
  client: ReturnType<typeof agentClient>,
  authRequestId: string,
): Promise<NonNullable<McpAuthorizationContext>> {
  const context = await client.mcpAuthorizationContext(authRequestId);
  if (!context) {
    throw new BffError(404, "MCP authorization request is no longer pending");
  }
  if (context.server.auth.type !== "oauth") {
    throw new BffError(409, "MCP server is not configured for OAuth");
  }
  return context;
}

async function finishOrPersist(
  client: ReturnType<typeof agentClient>,
  context: NonNullable<McpAuthorizationContext>,
  provider: OAuthProvider,
  result: "AUTHORIZED" | "REDIRECT",
): Promise<McpOAuthStartResult> {
  if (result === "AUTHORIZED") {
    const completed = await client.completeMcpAuthorization(
      context.request.authRequestId,
      provider.oauthState(context.server.id),
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
    provider.flow(),
  );
  if (!saved) {
    throw new BffError(409, "The waiting Turn no longer accepts authorization");
  }
  return {status: "redirect", authorizationUrl};
}

function callbackUrl(requestUrl: string): string {
  return new URL("/api/mcp-oauth/callback", requestUrl).toString();
}

function clientMetadataUrl(requestUrl: string): string {
  return new URL("/api/mcp-oauth/client-metadata", requestUrl).toString();
}

function callbackState(agentId: string, authRequestId: string): string {
  return Buffer.from(
    JSON.stringify({agentId, authRequestId, nonce: crypto.randomUUID()}),
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

/** In-memory SDK adapter whose complete state is persisted by the Agent VO. */
class OAuthProvider implements OAuthClientProvider {
  authorizationUrl?: string;
  private codeVerifierValue?: string;
  private tokensValue?: StoredOAuthTokens;
  private clientInformationValue?: StoredOAuthClientInformation;
  private discoveryStateValue?: OAuthDiscoveryState;

  private constructor(
    readonly redirectUrl: string,
    readonly clientMetadataUrl: string,
    private readonly stateValue: string,
  ) {}

  static start(
    context: NonNullable<McpAuthorizationContext>,
    redirectUrl: string,
    metadataUrl: string,
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

  static resume(flow: McpOAuthFlow, metadataUrl: string): OAuthProvider {
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
