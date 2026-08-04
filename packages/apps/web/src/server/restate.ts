import "server-only";

import {AgentClientError, createAgentClient} from "@restate-agents/client";

const DEFAULT_INGRESS_URL = "http://localhost:8080";

function ingressUrl() {
  return (process.env.RESTATE_INGRESS_URL ?? DEFAULT_INGRESS_URL).replace(
    /\/+$/,
    "",
  );
}

function ingressHeaders(contentType = false): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = process.env.RESTATE_AUTH_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (contentType) headers["content-type"] = "application/json";
  return headers;
}

function requireAgentId(agentId: string) {
  const normalized = agentId.trim();
  if (!normalized) throw new BffError(400, "Agent ID must not be empty");
  if (normalized.length > 256) {
    throw new BffError(400, "Agent ID must not exceed 256 characters");
  }
  return normalized;
}

export class BffError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BffError";
  }
}

export function agentClient(agentId: string) {
  return createAgentClient({
    ingressUrl: ingressUrl(),
    agentId: requireAgentId(agentId),
    headers: ingressHeaders(),
  });
}

export async function invokeEvals(input: unknown, signal: AbortSignal) {
  const response = await fetch(`${ingressUrl()}/Evals/all`, {
    method: "POST",
    headers: ingressHeaders(true),
    body: JSON.stringify(input),
    cache: "no-store",
    signal,
  });
  const body = await response.text();
  if (!response.ok) {
    let message = body || `${response.status} ${response.statusText}`;
    try {
      message = (JSON.parse(body) as {message?: string}).message ?? message;
    } catch {
      // Preserve a non-JSON Restate error response.
    }
    throw new BffError(response.status, message);
  }
  return body ? (JSON.parse(body) as unknown) : null;
}

export function errorResponse(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") {
    return new Response(null, {status: 499});
  }
  if (error instanceof BffError || error instanceof AgentClientError) {
    return Response.json({message: error.message}, {status: error.status});
  }
  console.error(error);
  return Response.json(
    {message: error instanceof Error ? error.message : "Unexpected BFF error"},
    {status: 500},
  );
}
