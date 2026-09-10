import "server-only";
import {sealMcpToken} from "@restate-agents/secrets";
import {BffError} from "./restate";
import {requireUser} from "./user-auth";
/** Plaintext stops at the BFF. User state and ingress contain only ciphertext. */
export async function completeMcpBearerAuthorization(
  agentId: string | undefined,
  body: {authRequestId: string; accessToken: string},
): Promise<boolean> {
  if (
    typeof body?.authRequestId !== "string" ||
    typeof body?.accessToken !== "string" ||
    !body.accessToken.trim()
  )
    throw new BffError(400, "An authorization request and token are required");
  const user = await requireUser();
  if (agentId && !(await user.client.ownsAgent(agentId)))
    throw new BffError(404, "Agent not found");
  const context = await user.client.mcpAuthorizationContext(body.authRequestId);
  if (context?.request.authType !== "bearer")
    throw new BffError(409, "This authorization request is no longer pending");
  return user.client.completeMcpBearerAuthorization(
    context.request.authRequestId,
    sealMcpToken(user.userId, context.server.id, body.accessToken),
  );
}
