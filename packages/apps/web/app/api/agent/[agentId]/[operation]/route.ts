import type {ScheduleSpecInput} from "@restate-agents/client";
import type {ApprovalResolution, Guardrail} from "@restate-agents/types";
import {
  agentClient,
  BffError,
  errorResponse,
} from "../../../../../src/server/restate";

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
    const client = agentClient(agentId);
    const {searchParams} = new URL(request.url);

    switch (operation) {
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
      case "profile":
        return Response.json(await client.profile());
      case "approvals":
        return Response.json(await client.approvals());
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
    const {agentId, operation} = await context.params;
    const client = agentClient(agentId);

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
