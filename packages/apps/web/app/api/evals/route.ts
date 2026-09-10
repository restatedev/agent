import {
  BffError,
  errorResponse,
  invokeEvals,
} from "../../../src/server/restate";
import {requireSameOrigin, requireUser} from "../../../src/server/user-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await requireUser();
    if (process.env.ENABLE_WEB_EVALS !== "true")
      throw new BffError(
        403,
        "Web evals are disabled; run evals on the trusted internal ingress",
      );
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
