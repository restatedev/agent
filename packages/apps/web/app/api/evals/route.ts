import {
  BffError,
  errorResponse,
  invokeEvals,
} from "../../../src/server/restate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      throw new BffError(400, "Expected a JSON request body");
    }
    return Response.json(await invokeEvals(input, request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}
