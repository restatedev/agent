export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  const redirectUrl = new URL("/api/mcp-oauth/callback", request.url);
  return Response.json({
    client_name: "Restate Agent",
    redirect_uris: [redirectUrl.toString()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}
