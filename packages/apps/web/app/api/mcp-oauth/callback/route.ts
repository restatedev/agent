import {
  finishMcpOAuth,
  mcpOAuthCallbackTarget,
} from "../../../../src/server/mcp-oauth";
import {publicUrl} from "../../../../src/server/public-url";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  let agentId: string | undefined;
  try {
    const target = mcpOAuthCallbackTarget(request);
    agentId = target.agentId;
    const result = await finishMcpOAuth(request, target);
    if (result.status === "redirect") {
      return Response.redirect(result.authorizationUrl);
    }
    return Response.redirect(returnUrl(request, agentId, "completed"));
  } catch {
    // Provider errors can contain token-exchange requests. Never log them.
    console.warn("MCP OAuth callback failed");
    return Response.redirect(returnUrl(request, agentId, "failed"));
  }
}

function returnUrl(
  request: Request,
  agentId: string | undefined,
  result: "completed" | "failed",
): URL {
  const url = publicUrl(request, "/");
  if (agentId) {
    url.searchParams.set("agent", agentId);
  }
  url.searchParams.set("mcpAuth", result);
  return url;
}
