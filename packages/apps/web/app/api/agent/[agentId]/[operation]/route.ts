import {
  isOperation,
  MUTATIONS,
  READS,
} from "../../../../../src/server/operations";
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

function json(value: unknown) {
  return Response.json(value ?? null, {
    headers: {"Cache-Control": "private, no-store"},
  });
}

/** Serves the READS table in src/server/operations.ts. */
export async function GET(request: Request, context: RouteContext) {
  try {
    // Reads expose transcripts, memories and approvals; see trustedOrigin.
    trustedOrigin(request);
    const {agentId, operation} = await context.params;
    if (!isOperation(READS, operation)) {
      throw new UiRequestError(404, `Unknown agent read: ${operation}`);
    }
    const read = READS[operation];
    return json(await read(agentClient(agentId), request));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Serves the MUTATIONS table, each with a validated JSON body. */
export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const {agentId, operation} = await context.params;
    if (!isOperation(MUTATIONS, operation)) {
      throw new UiRequestError(404, `Unknown agent mutation: ${operation}`);
    }
    const mutation = MUTATIONS[operation];
    const body = await readJson(request);
    return json(await mutation.execute(agentClient(agentId), body));
  } catch (error) {
    return errorResponse(error);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new UiRequestError(400, "Expected a JSON request body");
  }
}
