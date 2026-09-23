import "server-only";

import {
  AgentClientError,
  createAgentClient,
  IngressClientError,
} from "@restate-agents/client";

const DEFAULT_INGRESS_URL = "http://localhost:8080";

function ingressUrl() {
  return (process.env.RESTATE_INGRESS_URL ?? DEFAULT_INGRESS_URL).replace(
    /\/+$/,
    "",
  );
}

function ingressHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = process.env.RESTATE_AUTH_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function requireAgentId(agentId: string) {
  const normalized = agentId.trim();
  if (!normalized) throw new UiRequestError(400, "Agent ID must not be empty");
  if (normalized.length > 256) {
    throw new UiRequestError(400, "Agent ID must not exceed 256 characters");
  }
  return normalized;
}

export class UiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UiRequestError";
  }
}

export function agentClient(agentId: string) {
  return createAgentClient({
    ingressUrl: ingressUrl(),
    agentId: requireAgentId(agentId),
    headers: ingressHeaders(),
  });
}

export function errorResponse(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    return new Response(null, {status: 499});
  }
  if (error instanceof UiRequestError || error instanceof AgentClientError) {
    return Response.json({message: error.message}, {status: error.status});
  }
  if (
    error instanceof IngressClientError &&
    error.status >= 400 &&
    error.status < 500
  ) {
    let message = "Request rejected by the runtime";
    try {
      const body = JSON.parse(error.responseText);
      if (typeof body.message === "string") message = body.message;
    } catch {}
    return Response.json({message}, {status: error.status});
  }
  // Unknown provider/SDK errors may carry request headers or token material.
  console.error("Unexpected UI proxy request failure");
  return Response.json({message: "Unexpected UI proxy error"}, {status: 500});
}

/** The UI is a local operator tool. Reject cross-origin browser writes. */
export function requireSameOrigin(request: Request) {
  const expected = new URL(process.env.APP_PUBLIC_URL ?? request.url);
  // Next.js can reconstruct request.url with localhost even when the browser
  // uses 127.0.0.1. Host retains the address the browser actually requested.
  if (!process.env.APP_PUBLIC_URL) {
    expected.host = request.headers.get("host") ?? expected.host;
    // The default UI is local. Do not let an arbitrary Host header redefine
    // the trusted origin when a domain is pointed at the loopback listener.
    if (!["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname))
      throw new UiRequestError(403, "Untrusted local UI host");
  }
  if (request.headers.get("origin") !== expected.origin)
    throw new UiRequestError(403, "Cross-origin action rejected");
}
