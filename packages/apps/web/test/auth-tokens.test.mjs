import assert from "node:assert/strict";
import {test} from "node:test";
import {sealSecret} from "@restate-agents/secrets";
import {AUTH_LEASE_MS, readSession, sealSession, sealAgentAccess, verifyAgentAccess, sealWorkspaceAccess, readWorkspaceAccess} from "../src/server/auth-tokens.ts";

process.env.APP_SECRET_KEY = "auth-lease-test-key-never-a-real-secret";
const now = 1_800_000_000_000;
const audience = "https://app.example";
const session = {userId: "alice", sessionId: "session-a", issuedAt: now, validatedUntil: now + AUTH_LEASE_MS, expiresAt: now + 86400000};
const tamper = token => `${token.slice(0, 15)}${token[15] === "A" ? "B" : "A"}${token.slice(16)}`;

test("session cookies are opaque, authenticated and audience-bound", () => {
  const token = sealSession(session, audience);
  assert.ok(!token.includes("alice"));
  assert.deepEqual(readSession(token, audience, now), session);
  for (const value of [undefined, "alice", JSON.stringify(session), tamper(token), "x".repeat(48001)])
    assert.equal(readSession(value, audience, now), null);
  assert.equal(readSession(token, "https://evil.example", now), null);
});

test("stale validation leases remain readable for revalidation, absolute expiry does not", () => {
  const token = sealSession(session, audience);
  assert.ok(readSession(token, audience, now + AUTH_LEASE_MS));
  assert.equal(readSession(token, audience, session.expiresAt), null);
  assert.ok(readSession(token, audience, now - 1000), "small replica clock skew is tolerated");
  assert.equal(readSession(token, audience, now - 5001), null);
  for (const patch of [{validatedUntil: now + AUTH_LEASE_MS + 1}, {validatedUntil: now}, {expiresAt: now + 1}, {userId: ""}, {issuedAt: "wrong"}])
    assert.equal(readSession(sealSession({...session, ...patch}, audience), audience, now), null);
});

test("agent proof cannot cross user, login session, agent, origin or token purpose", () => {
  const token = sealAgentAccess(session, "agent-a", audience, now);
  assert.equal(verifyAgentAccess(token, session, "agent-a", audience, now), true);
  for (const [value, identity, agent, origin] of [
    [tamper(token), session, "agent-a", audience],
    [token, {...session, userId: "bob"}, "agent-a", audience],
    [token, {...session, sessionId: "new-login"}, "agent-a", audience],
    [token, session, "agent-b", audience],
    [token, session, "agent-a", "https://evil.example"],
    [sealSession(session, audience), session, "agent-a", audience],
    [sealWorkspaceAccess(session, ["agent-a"], audience, now), session, "agent-a", audience],
  ]) assert.equal(verifyAgentAccess(value, identity, agent, origin, now), false);
});

test("ownership proofs expire even when supplied with a renewed session", () => {
  const token = sealAgentAccess(session, "a", audience, now);
  const workspace = sealWorkspaceAccess(session, ["a"], audience, now);
  const renewed = {...session, validatedUntil: now + 2 * AUTH_LEASE_MS};
  assert.equal(verifyAgentAccess(token, renewed, "a", audience, now + AUTH_LEASE_MS), false);
  assert.equal(readWorkspaceAccess(workspace, renewed, audience, now + AUTH_LEASE_MS), null);
  assert.throws(() => sealAgentAccess(session, "a", audience, now + AUTH_LEASE_MS), /revalidated/);
  assert.throws(() => sealWorkspaceAccess(session, ["a"], audience, session.expiresAt), /revalidated/);
});

test("workspace proofs authenticate the full directory and reject substitutions", () => {
  const token = sealWorkspaceAccess(session, ["a", "b"], audience, now);
  assert.deepEqual(readWorkspaceAccess(token, session, audience, now), ["a", "b"]);
  assert.equal(readWorkspaceAccess(token, {...session, userId: "bob"}, audience, now), null);
  assert.equal(readWorkspaceAccess(token, {...session, sessionId: "other"}, audience, now), null);
  assert.equal(readWorkspaceAccess(token, session, "other-origin", now), null);
  assert.equal(readWorkspaceAccess(tamper(token), session, audience, now), null);
  for (const ids of [["a", "a"], [42], Array.from({length: 101}, (_, i) => String(i))]) {
    const malformed = sealSecret(JSON.stringify({issuedAt: now, expiresAt: now + AUTH_LEASE_MS, agentIds: ids}), ["bff-workspace-v1", audience, session.userId, session.sessionId]);
    assert.equal(readWorkspaceAccess(malformed, session, audience, now), null);
  }
});

test("a proof minted late cannot extend the session validation window", () => {
  const token = sealAgentAccess(session, "a", audience, now + AUTH_LEASE_MS - 1);
  assert.equal(verifyAgentAccess(token, session, "a", audience, now + AUTH_LEASE_MS - 1), true);
  assert.equal(verifyAgentAccess(token, {...session, validatedUntil: session.expiresAt}, "a", audience, now + AUTH_LEASE_MS), false);
});
