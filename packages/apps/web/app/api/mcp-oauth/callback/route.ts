import {
  finishMcpOAuth,
  mcpOAuthCallbackTarget,
} from "../../../../src/server/mcp-oauth";

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
    return Response.redirect(returnUrl(request.url, agentId, "completed"));
  } catch (error) {
    console.error("MCP OAuth callback failed", error);
    return Response.redirect(returnUrl(request.url, agentId, "failed"));
  }
}

function returnUrl(
  requestUrl: string,
  agentId: string | undefined,
  result: "completed" | "failed",
): URL {
  const url = new URL("/", requestUrl);
  if (agentId) {
    url.searchParams.set("agent", agentId);
  }
  url.searchParams.set("mcpAuth", result);
  return url;
}
