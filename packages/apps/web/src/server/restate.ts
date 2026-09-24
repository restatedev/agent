import "server-only";
import {AgentClientError, createAgentClient} from "@restate-agents/client";

import {UiRequestError} from "./request-guard";

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
  // The ID becomes an ingress path segment; dot segments would be resolved
  // away and address a different URL.
  if (normalized === "." || normalized === "..") {
    throw new UiRequestError(400, "Agent ID must not be a dot segment");
  }
  return normalized;
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
  // Unknown provider/SDK errors may carry request headers or token material.
  console.error("Unexpected UI proxy request failure");
  return Response.json({message: "Unexpected UI proxy error"}, {status: 500});
}
