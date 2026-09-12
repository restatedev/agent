import {createHash} from "node:crypto";
import {
  McpServerSchema,
  WorkspaceSyncRequestSchema,
} from "@restate-agents/types";
import {completeMcpBearerAuthorization} from "../../../../src/server/mcp-bearer";
import {startMcpOAuth} from "../../../../src/server/mcp-oauth";
import {
  agentClient,
  BffError,
  errorResponse,
} from "../../../../src/server/restate";
import {
  authorizeWorkspace,
  requireSameOrigin,
  requireUser,
} from "../../../../src/server/user-auth";
import {
  syncWorkspace,
  WorkspaceSyncError,
} from "../../../../src/server/workspace-sync";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = {params: Promise<{operation: string}>};
export async function GET(request: Request, context: Context) {
  try {
    const {client} = await requireUser();
    const {operation} = await context.params;
    if (operation === "profile") return Response.json(await client.profile());
    if (operation === "connections")
      return Response.json(await client.connections());
    if (operation === "agent-completions") {
      // Only enumerate the authenticated user's directory, never caller IDs.
      const {agents} = await client.profile();
      const completions: Array<{agentId: string; sequence: number}> = [];
      // Bound ingress fan-out; one unavailable agent must not hide the others.
      for (let offset = 0; offset < agents.length; offset += 8) {
        if (request.signal.aborted)
          throw new DOMException("Aborted", "AbortError");
        const batch = await Promise.allSettled(
          agents.slice(offset, offset + 8).map(async ({agentId}) => ({
            agentId,
            sequence: await agentClient(agentId).lastTurnSequence({
              signal: AbortSignal.any([
                request.signal,
                AbortSignal.timeout(5_000),
              ]),
            }),
          })),
        );
        for (const result of batch) {
          if (result.status === "fulfilled") completions.push(result.value);
        }
      }
      if (agents.length > 0 && completions.length === 0) {
        throw new BffError(
          503,
          "Agent completion checks are unavailable; retrying",
        );
      }
      return Response.json(completions);
    }
    throw new BffError(404, "Unknown user operation");
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    requireSameOrigin(request);
    const {operation} = await context.params;
    if (operation === "sync") {
      await requireUser();
      const text = await request.text();
      if (text.length > 128_000)
        throw new BffError(400, "Sync request too large");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new BffError(400, "Invalid sync request");
      }
      const parsed = WorkspaceSyncRequestSchema.safeParse(body);
      if (!parsed.success) throw new BffError(400, "Invalid sync request");
      try {
        const update = await syncWorkspace(
          parsed.data,
          {
            authenticate: requireUser,
            authorize: authorizeWorkspace,
            agent: agentClient,
          },
          request.signal,
        );
        return Response.json(update, {
          headers: {"Cache-Control": "private, no-store", Vary: "Cookie"},
        });
      } catch (error) {
        if (error instanceof WorkspaceSyncError)
          throw new BffError(error.status, error.message);
        throw error;
      }
    }
    const user = await requireUser();
    const {client} = user;
    const body = await request.json();
    switch (operation) {
      case "delete-agent": {
        if (
          typeof body.agentId !== "string" ||
          !body.agentId ||
          body.agentId.length > 256
        )
          throw new BffError(400, "Agent ID required");
        // User VO checks membership; callers cannot target another user's agent.
        return Response.json(await client.deleteAgent(body.agentId));
      }
      case "agent": {
        if (
          typeof body.name !== "string" ||
          !body.name.trim() ||
          body.name.length > 100 ||
          typeof body.creationId !== "string" ||
          !/^[a-f0-9-]{36}$/.test(body.creationId)
        )
          throw new BffError(400, "Agent name and creation ID required");
        const agentId = createHash("sha256")
          .update(JSON.stringify([user.userId, body.creationId]))
          .digest("hex");
        return Response.json(
          await client.createAgent({agentId, name: body.name.trim()}),
        );
      }
      case "connection": {
        const parsed = McpServerSchema.safeParse(body);
        if (!parsed.success) throw new BffError(400, "Invalid connection");
        return Response.json(await client.upsertConnection(parsed.data));
      }
      case "remove-connection":
        return Response.json(await client.removeConnection(body.id));
      case "disconnect-connection":
        await client.disconnectConnection(body.id);
        return Response.json(null);
      case "discover-connection":
        return Response.json(await client.discoverConnection(body.id));
      case "begin-authorization":
        return Response.json(
          await client.beginAuthorization(
            body.connectionId,
            crypto.randomUUID(),
          ),
        );
      case "start-authorization":
        return Response.json(
          await startMcpOAuth(request, undefined, body.authRequestId),
        );
      case "complete-bearer":
        return Response.json(
          await completeMcpBearerAuthorization(undefined, body),
        );
      default:
        throw new BffError(404, "Unknown user operation");
    }
  } catch (error) {
    return errorResponse(error);
  }
}
