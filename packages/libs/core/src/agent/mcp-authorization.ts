// Per-turn UI actions remain Agent-owned; credentials and shared flows are User-owned.
import type {
  McpAuthorizationRequest,
  McpAuthorizationResolution,
} from "@restate-agents/types";
import {UserDefinition} from "@restate-agents/types/services";
import * as restate from "@restatedev/restate-sdk-gen";
import {mcpAuthorizationSignalName} from "../internal-types.js";

const REQUESTS = "mcp/authorization-requests";
export function* requests(): restate.Operation<McpAuthorizationRequest[]> {
  return (
    (yield* restate.sharedState().get<McpAuthorizationRequest[]>(REQUESTS)) ??
    []
  );
}
export function* register(
  request: McpAuthorizationRequest,
): restate.Operation<McpAuthorizationRequest> {
  const list = yield* requests();
  const existing = list.find(
    (r) => r.turnId === request.turnId && r.serverId === request.serverId,
  );
  if (existing) return existing;
  const safe = {...request, rejectedToken: undefined};
  restate.state().set(REQUESTS, [...list, safe]);
  return safe;
}
export function* cancel(input: {
  authRequestId: string;
  turnId: string;
}): restate.Operation<McpAuthorizationRequest | undefined> {
  const list = yield* requests();
  const request = list.find(
    (r) => r.authRequestId === input.authRequestId && r.turnId === input.turnId,
  );
  if (!request) return;
  restate.state().set(
    REQUESTS,
    list.filter((r) => r !== request),
  );
  const owner = yield* restate.state().get<{ownerUserId: string}>("ownership");
  const agentId = restate.handlerRequest().key;
  if (owner && agentId)
    yield* restate
      .sendClient(UserDefinition, owner.ownerUserId)
      .cancelMcpAuthorization({
        ...input,
        agentId,
      });
  return request;
}
export function* clearTurn(
  turnId: string,
): restate.Operation<McpAuthorizationRequest[]> {
  const removed = (yield* requests()).filter((r) => r.turnId === turnId);
  for (const request of removed) yield* cancel(request);
  return removed;
}
export function* cancelTurn(
  turnId: string,
  reason: string,
): restate.Operation<McpAuthorizationRequest[]> {
  const removed = yield* clearTurn(turnId);
  for (const request of removed) signal(request, {status: "cancelled", reason});
  return removed;
}
export function* resolve(
  input: {
    authRequestId: string;
    turnId: string;
    resolution: McpAuthorizationResolution;
  },
  activeTurnId?: string,
): restate.Operation<boolean> {
  const request = (yield* requests()).find(
    (r) => r.authRequestId === input.authRequestId && r.turnId === input.turnId,
  );
  if (
    !request ||
    request.turnId !== activeTurnId ||
    (input.resolution.status === "authorized" &&
      input.resolution.credential.serverId !== request.serverId)
  )
    return false;
  const list = yield* requests();
  restate.state().set(
    REQUESTS,
    list.filter(
      (r) =>
        r.authRequestId !== request.authRequestId ||
        r.turnId !== request.turnId,
    ),
  );
  signal(request, input.resolution);
  return true;
}
function signal(
  request: McpAuthorizationRequest,
  resolution: McpAuthorizationResolution,
): void {
  restate
    .invocation(request.turnId)
    .signal<McpAuthorizationResolution>(
      mcpAuthorizationSignalName(request.authRequestId),
    )
    .resolve(resolution);
}
