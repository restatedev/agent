import {BffError, errorResponse} from "../../../../src/server/restate";
import {
  finishGoogleLogin,
  logout,
  startGoogleLogin,
} from "../../../../src/server/user-auth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = {params: Promise<{operation: string}>};
export async function GET(request: Request, context: Context) {
  try {
    const {operation} = await context.params;
    if (operation === "login") return await startGoogleLogin();
    if (operation === "callback") return await finishGoogleLogin(request);
    throw new BffError(404, "Unknown authentication operation");
  } catch (error) {
    return errorResponse(
      error instanceof BffError
        ? error
        : new BffError(400, "Sign in failed. Start a new login and try again."),
    );
  }
}
export async function POST(request: Request, context: Context) {
  try {
    if ((await context.params).operation !== "logout")
      throw new BffError(404, "Unknown authentication operation");
    return await logout(request);
  } catch (error) {
    return errorResponse(error);
  }
}
