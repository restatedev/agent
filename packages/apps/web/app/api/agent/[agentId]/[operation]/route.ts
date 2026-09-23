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
import {
  agentClient,
  BffError,
  errorResponse,
  requireSameOrigin,
} from "../../../../../src/server/restate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{agentId: string; operation: string}>;
};

function json(value: unknown, init?: ResponseInit) {
  return Response.json(value, {
    ...init,
    headers: {"Cache-Control": "no-store"},
  });
}

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
    const client = agentClient(agentId);
    const {searchParams} = new URL(request.url);

    switch (operation) {
      case "snapshot":
        return json(await loadAgentSnapshot(client, request.signal), {
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
        return json(
          await syncAgentSnapshot(client, since, fromSequence, {
            signal: request.signal,
            idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
          }),
          {headers: {"Cache-Control": "private, no-store"}},
        );
      }
      case "history":
        return json(
          await client.history(
            integerParameter(searchParams, "fromSequence", 1),
            integerParameter(searchParams, "limit", 100),
          ),
        );
      case "notifications":
        return json(await client.notifications());
      case "watch":
        return json(
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
        return json(await client.toolCatalog());
      case "profile":
        return json(await client.profile());
      case "approvals":
        return json(await client.approvals());
      case "schedules":
        return json(await client.schedules());
      case "children":
        return json(await client.children());
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
    const client = agentClient(agentId);
    const agent = await client.metadata();
    if (
      agent.parentAgentId &&
      operation !== "interrupt" &&
      operation !== "resolve-approval"
    )
      throw new BffError(403, "Only the parent can modify a child agent");

    switch (operation) {
      case "ask": {
        const body = await input<{message?: string}>(request);
        return json(await client.ask(body.message));
      }
      case "steer": {
        const body = await input<{message: string}>(request);
        return json(await client.steer(body.message));
      }
      case "interrupt": {
        const body = await input<{reason: string; message?: string}>(request);
        if (agent.parentAgentId) {
          if (body.message !== undefined)
            throw new BffError(
              403,
              "Cannot send a replacement message to a sub-agent",
            );
          return json(await client.interrupt("Interrupted by the user"));
        }
        return json(await client.interrupt(body.reason, body.message));
      }
      case "instructions": {
        const body = await input<{instructions: string | null}>(request);
        await client.setInstructions(body.instructions);
        return json(null);
      }
      case "guardrails": {
        const body = await input<{guardrails: Guardrail[]}>(request);
        await client.setGuardrails(body.guardrails);
        return json(null);
      }
      case "web-search": {
        const parsed = SetWebSearchEnabledSchema.safeParse(
          await input<unknown>(request),
        );
        if (!parsed.success)
          throw new BffError(400, "enabled must be a boolean");
        await client.setWebSearchEnabled(parsed.data.enabled);
        return json(null);
      }
      case "tools": {
        const parsed = AgentToolsSchema.safeParse(
          await input<unknown>(request),
        );
        if (!parsed.success) throw new BffError(400, "Invalid tool selection");
        await client.setTools(parsed.data);
        return json(null);
      }
      case "delete-memory": {
        const body = await input<{key: string}>(request);
        return json(await client.deleteMemory(body.key));
      }
      case "cancel-schedule": {
        const body = await input<{scheduleId: string}>(request);
        return json(await client.cancelSchedule(body.scheduleId));
      }
      case "resolve-approval":
        return json(
          await client.resolveApproval(
            await input<ApprovalResolution>(request),
          ),
        );
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
