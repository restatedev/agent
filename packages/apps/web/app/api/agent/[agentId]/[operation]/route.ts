import type {AgentClient} from "@restate-agents/client";
import {
  type AgentNotificationSnapshot,
  AgentNotificationSnapshotSchema,
  ApprovalResolutionSchema,
  AskRequestSchema,
  InterruptRequestSchema,
  MemoryKeyRequestSchema,
  ProfileUpdateSchema,
  ScheduleIdRequestSchema,
  SteerRequestSchema,
} from "@restate-agents/types";

import {
  loadAgentSnapshot,
  syncAgentSnapshot,
} from "../../../../../src/server/agent-snapshot";
import {
  requireSameOrigin,
  trustedOrigin,
  UiRequestError,
} from "../../../../../src/server/request-guard";
import {agentClient, errorResponse} from "../../../../../src/server/restate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{agentId: string; operation: string}>;
};

function json(value: unknown, init?: ResponseInit) {
  return Response.json(value ?? null, {
    ...init,
    headers: {"Cache-Control": "private, no-store"},
  });
}

// The part of a zod schema the route uses.
type Schema<T> = {
  safeParse(
    value: unknown,
  ):
    | {success: true; data: T}
    | {success: false; error: {issues: {message: string}[]}};
};
type Mutation = {
  input: Schema<unknown>;
  run(client: AgentClient, body: never): Promise<unknown>;
};
const mutation = <T>(
  input: Schema<T>,
  run: (client: AgentClient, body: T) => Promise<unknown>,
): Mutation => ({input, run});

/** Every browser mutation, with the schema its JSON body must satisfy. */
const MUTATIONS: Record<string, Mutation> = {
  ask: mutation(AskRequestSchema, (client, {message}) => client.ask(message)),
  steer: mutation(SteerRequestSchema, (client, {message}) =>
    client.steer(message),
  ),
  interrupt: mutation(InterruptRequestSchema, (client, {reason, message}) =>
    client.interrupt(reason, message),
  ),
  profile: mutation(ProfileUpdateSchema, (client, update) =>
    client.updateProfile(update),
  ),
  "delete-memory": mutation(MemoryKeyRequestSchema, (client, {key}) =>
    client.deleteMemory(key),
  ),
  "cancel-schedule": mutation(ScheduleIdRequestSchema, (client, {scheduleId}) =>
    client.cancelSchedule(scheduleId),
  ),
  "resolve-approval": mutation(ApprovalResolutionSchema, (client, resolution) =>
    client.resolveApproval(resolution),
  ),
};

export async function GET(request: Request, context: RouteContext) {
  try {
    // Reads expose transcripts, memories and approvals; see trustedOrigin.
    trustedOrigin(request);
    const {agentId, operation} = await context.params;
    const client = agentClient(agentId);
    switch (operation) {
      case "snapshot":
        return json(await loadAgentSnapshot(client, request.signal));
      case "sync":
        return json(await sync(client, request));
      case "profile":
        return json(await client.profile());
      case "tool-catalog":
        return json(await client.toolCatalog());
      default:
        throw new UiRequestError(404, `Unknown agent read: ${operation}`);
    }
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const {agentId, operation} = await context.params;
    const handler = MUTATIONS[operation];
    if (!handler)
      throw new UiRequestError(404, `Unknown agent mutation: ${operation}`);
    const parsed = handler.input.safeParse(await body(request));
    if (!parsed.success)
      throw new UiRequestError(
        400,
        `Invalid ${operation} request: ${parsed.error.issues[0]?.message}`,
      );
    return json(await handler.run(agentClient(agentId), parsed.data as never));
  } catch (error) {
    return errorResponse(error);
  }
}

async function sync(client: AgentClient, request: Request) {
  const searchParams = new URL(request.url).searchParams;
  let since: AgentNotificationSnapshot;
  try {
    since = AgentNotificationSnapshotSchema.parse(
      JSON.parse(searchParams.get("since") ?? "null"),
    );
  } catch {
    throw new UiRequestError(400, "Invalid notification cursor");
  }
  const fromSequence = Number(searchParams.get("fromSequence") ?? 1);
  if (!Number.isSafeInteger(fromSequence) || fromSequence < 1)
    throw new UiRequestError(400, "fromSequence must be a positive integer");
  return syncAgentSnapshot(client, since, fromSequence, {
    signal: request.signal,
    idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
  });
}

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new UiRequestError(400, "Expected a JSON request body");
  }
}
