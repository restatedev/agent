import type {ScheduleSpecInput} from "@restate-agents/client";
import type {
  AgentNotificationSnapshot,
  ApprovalResolution,
  Guardrail,
} from "@restate-agents/types";
import {
  AgentNotificationSnapshotSchema,
  AgentToolsSchema,
  SetWebSearchEnabledSchema,
} from "@restate-agents/types";
import {
  loadAgentSnapshot,
  syncAgentSnapshot,
} from "../../../../../src/server/agent-snapshot";
import {completeMcpBearerAuthorization} from "../../../../../src/server/mcp-bearer";
import {startMcpOAuth} from "../../../../../src/server/mcp-oauth";
import {BffError, errorResponse} from "../../../../../src/server/restate";

import {
  authorizedAgent,
  requireSameOrigin,
} from "../../../../../src/server/user-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{agentId: string; operation: string}>;
};

function integerParameter(
  searchParams: URLSearchParams,
  name: string,
  fallback: number,
) {
  const raw = searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new BffError(400, `${name} must be a non-negative integer`);
  }
  return value;
}

async function input<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new BffError(400, "Expected a JSON request body");
  }
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const {agentId, operation} = await context.params;
    const {client} = await authorizedAgent(agentId);
    const {searchParams} = new URL(request.url);

    switch (operation) {
      case "snapshot":
        return Response.json(await loadAgentSnapshot(client, request.signal), {
          headers: {"Cache-Control": "private, no-store"},
        });
      case "sync": {
        let since: AgentNotificationSnapshot;
        try {
          since = AgentNotificationSnapshotSchema.parse(
            JSON.parse(searchParams.get("since") ?? "null"),
          );
        } catch {
          throw new BffError(400, "Invalid notification cursor");
        }
        const fromSequence = integerParameter(searchParams, "fromSequence", 1);
        if (fromSequence < 1)
          throw new BffError(400, "fromSequence must be positive");
        return Response.json(
          await syncAgentSnapshot(client, since, fromSequence, {
            signal: request.signal,
            idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
          }),
          {headers: {"Cache-Control": "private, no-store"}},
        );
      }
      case "history":
        return Response.json(
          await client.history(
            integerParameter(searchParams, "fromSequence", 1),
            integerParameter(searchParams, "limit", 100),
          ),
        );
      case "notifications":
        return Response.json(await client.notifications());
      case "watch":
        return Response.json(
          await client.watchNotifications(
            integerParameter(searchParams, "afterRevision", 0),
            integerParameter(searchParams, "timeoutSeconds", 25),
            {
              idempotencyKey:
                request.headers.get("idempotency-key") ?? undefined,
              signal: request.signal,
            },
          ),
        );
      case "tool-catalog":
        return Response.json(await client.toolCatalog());
      case "profile":
        return Response.json(await client.profile());
      case "approvals":
        return Response.json(await client.approvals());
      case "mcp-authorizations":
        return Response.json(await client.mcpAuthorizations());
      case "schedules":
        return Response.json(await client.schedules());
      default:
        throw new BffError(404, `Unknown agent read operation: ${operation}`);
    }
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const {agentId, operation} = await context.params;
    const {client} = await authorizedAgent(agentId);

    switch (operation) {
      case "ask": {
        const body = await input<{message?: string}>(request);
        return Response.json(await client.ask(body.message));
      }
      case "steer": {
        const body = await input<{message: string}>(request);
        return Response.json(await client.steer(body.message));
      }
      case "interrupt": {
        const body = await input<{reason: string; message?: string}>(request);
        return Response.json(await client.interrupt(body.reason, body.message));
      }
      case "instructions": {
        const body = await input<{instructions: string | null}>(request);
        await client.setInstructions(body.instructions);
        return Response.json(null);
      }
      case "guardrails": {
        const body = await input<{guardrails: Guardrail[]}>(request);
        await client.setGuardrails(body.guardrails);
        return Response.json(null);
      }
      case "web-search": {
        const parsed = SetWebSearchEnabledSchema.safeParse(
          await input<unknown>(request),
        );
        if (!parsed.success)
          throw new BffError(400, "enabled must be a boolean");
        await client.setWebSearchEnabled(parsed.data.enabled);
        return Response.json(null);
      }
      case "tools": {
        const parsed = AgentToolsSchema.safeParse(
          await input<unknown>(request),
        );
        if (!parsed.success) throw new BffError(400, "Invalid tool selection");
        await client.setTools(parsed.data);
        return Response.json(null);
      }
      case "start-mcp-authorization": {
        const body = await input<{authRequestId: string}>(request);
        return Response.json(
          await startMcpOAuth(request, agentId, body.authRequestId),
        );
      }
      case "complete-mcp-bearer-authorization": {
        const body = await input<{
          authRequestId: string;
          accessToken: string;
        }>(request);
        return Response.json(
          await completeMcpBearerAuthorization(agentId, body),
        );
      }
      case "resolve-approval":
        return Response.json(
          await client.resolveApproval(
            await input<ApprovalResolution>(request),
          ),
        );
      case "schedule":
        return Response.json(
          await client.scheduleMessage(await input<ScheduleSpecInput>(request)),
        );
      case "cancel-schedule": {
        const body = await input<{scheduleId: string}>(request);
        return Response.json(await client.cancelSchedule(body.scheduleId));
      }
      default:
        throw new BffError(
          404,
          `Unknown agent mutation operation: ${operation}`,
        );
    }
  } catch (error) {
    return errorResponse(error);
  }
}
