import {publicUrl} from "../../../../src/server/public-url";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  const clientId = publicUrl(request, "/api/mcp-oauth/client-metadata");
  const redirectUrl = publicUrl(request, "/api/mcp-oauth/callback");
  return Response.json({
    client_id: clientId.toString(),
    client_name: "Restate Agent",
    redirect_uris: [redirectUrl.toString()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}
