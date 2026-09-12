// BFF-only AEAD authorization leases. No algorithm negotiation or browser secrets.
import {openSecret, sealSecret} from "@restate-agents/secrets";
import {EncryptedSecretSchema} from "@restate-agents/types";

export const AUTH_LEASE_MS = 5 * 60 * 1000;
// Allow small clock differences across BFF replicas, never extend expiry.
const ISSUED_AT_SKEW_MS = 5_000;
export const AGENT_ACCESS_HEADER = "x-agent-access";
export type SessionClaims = {
  userId: string;
  sessionId: string;
  issuedAt: number;
  validatedUntil: number;
  expiresAt: number;
};
type Lease = {issuedAt: number; expiresAt: number};
const string = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256;
const time = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
function read(
  value: string | undefined,
  binding: string[],
): Record<string, unknown> | null {
  if (!value || value.length > 48_000) return null;
  try {
    const decoded = JSON.parse(
      openSecret(EncryptedSecretSchema.parse(value), binding),
    );
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded
      : null;
  } catch {
    return null;
  }
}
function validLease(
  value: Record<string, unknown> | null,
  now: number,
): value is Record<string, unknown> & Lease {
  return Boolean(
    value &&
      time(value.issuedAt) &&
      time(value.expiresAt) &&
      value.issuedAt <= now + ISSUED_AT_SKEW_MS &&
      value.expiresAt > now &&
      value.expiresAt > value.issuedAt &&
      value.expiresAt - value.issuedAt <= AUTH_LEASE_MS,
  );
}
export function sealSession(claims: SessionClaims, audience: string) {
  return sealSecret(JSON.stringify(claims), ["bff-session-v2", audience]);
}
/** A stale validation lease is NOT authority: caller must re-read UserSession. */
export function readSession(
  value: string | undefined,
  audience: string,
  now = Date.now(),
): SessionClaims | null {
  const c = read(value, ["bff-session-v2", audience]);
  if (
    !c ||
    !string(c.userId) ||
    !string(c.sessionId) ||
    !time(c.issuedAt) ||
    !time(c.validatedUntil) ||
    !time(c.expiresAt) ||
    c.issuedAt > now + ISSUED_AT_SKEW_MS ||
    c.expiresAt <= now ||
    c.validatedUntil <= c.issuedAt ||
    c.validatedUntil > c.expiresAt ||
    c.validatedUntil - c.issuedAt > AUTH_LEASE_MS
  )
    return null;
  return c as SessionClaims;
}
function lease(session: SessionClaims, now: number): Lease {
  if (session.validatedUntil <= now || session.expiresAt <= now)
    throw new Error("Session must be revalidated before issuing access");
  return {
    issuedAt: now,
    expiresAt: Math.min(
      now + AUTH_LEASE_MS,
      session.validatedUntil,
      session.expiresAt,
    ),
  };
}
function binding(purpose: string, audience: string, session: SessionClaims) {
  return [purpose, audience, session.userId, session.sessionId];
}
export function sealAgentAccess(
  session: SessionClaims,
  agentId: string,
  audience: string,
  now = Date.now(),
) {
  return sealSecret(JSON.stringify(lease(session, now)), [
    ...binding("bff-agent-v1", audience, session),
    agentId,
  ]);
}
export function verifyAgentAccess(
  value: string | undefined,
  session: SessionClaims,
  agentId: string,
  audience: string,
  now = Date.now(),
) {
  return (
    session.validatedUntil > now &&
    validLease(
      read(value, [...binding("bff-agent-v1", audience, session), agentId]),
      now,
    )
  );
}
export function sealWorkspaceAccess(
  session: SessionClaims,
  agentIds: string[],
  audience: string,
  now = Date.now(),
) {
  return sealSecret(
    JSON.stringify({...lease(session, now), agentIds}),
    binding("bff-workspace-v1", audience, session),
  );
}
export function readWorkspaceAccess(
  value: string | undefined,
  session: SessionClaims,
  audience: string,
  now = Date.now(),
): string[] | null {
  const c = read(value, binding("bff-workspace-v1", audience, session));
  if (
    session.validatedUntil <= now ||
    !validLease(c, now) ||
    !Array.isArray(c.agentIds) ||
    c.agentIds.length > 100 ||
    !c.agentIds.every(string) ||
    new Set(c.agentIds).size !== c.agentIds.length
  )
    return null;
  return c.agentIds;
}
