import {createHash} from "node:crypto";
import {McpServerSchema} from "@restate-agents/types";
import {completeMcpBearerAuthorization} from "../../../../src/server/mcp-bearer";
import {startMcpOAuth} from "../../../../src/server/mcp-oauth";
import {BffError, errorResponse} from "../../../../src/server/restate";
import {requireSameOrigin, requireUser} from "../../../../src/server/user-auth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = {params: Promise<{operation: string}>};
export async function GET(_request: Request, context: Context) {
  try {
    const {client} = await requireUser();
    const {operation} = await context.params;
    if (operation === "profile") return Response.json(await client.profile());
    if (operation === "connections")
      return Response.json(await client.connections());
    throw new BffError(404, "Unknown user operation");
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const {client} = user;
    const body = await request.json();
    const {operation} = await context.params;
    switch (operation) {
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
