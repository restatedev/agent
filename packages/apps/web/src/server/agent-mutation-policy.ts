import type {UserAgent} from "@restate-agents/types";

/** Applied after ownership authorization, using the authoritative directory. */
export function allowsUserAgentMutation(
  agent: UserAgent,
  operation: string,
): boolean {
  return !agent.parentAgentId || operation === "interrupt";
}
