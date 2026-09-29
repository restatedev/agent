import {parseRunInput, runResponse} from "../../../src/server/ag-ui";
import {
  requireSameOrigin,
  UiRequestError,
} from "../../../src/server/request-guard";
import {agentClient, errorResponse} from "../../../src/server/restate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The AG-UI endpoint: POST a RunAgentInput, read the run as server-sent
 * events. The thread ID is the agent ID. See src/server/ag-ui.ts.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const input = parseRunInput(await readJson(request));
    const client = agentClient(input.threadId);
    return runResponse(client, input, request.signal);
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
