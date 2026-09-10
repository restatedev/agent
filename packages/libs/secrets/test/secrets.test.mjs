import assert from "node:assert/strict";
import crypto from "node:crypto";
import {syncBuiltinESMExports} from "node:module";
import {test} from "node:test";
import {gcmsiv} from "@noble/ciphers/aes.js";
import {
  McpAuthorizationCompletionSchema,
  McpBearerAuthorizationCompletionSchema,
  McpAuthorizationFlowUpdateSchema,
} from "@restate-agents/types";
import {
  sealSecret,
  openSecret,
  sealMcpToken,
  openMcpToken,
  sealMcpOAuthState,
  openMcpOAuthState,
  sealMcpOAuthFlow,
  openMcpOAuthFlow,
} from "../dist/index.js";

process.env.APP_SECRET_KEY = "test-key-only-32-bytes-not-a-real-secret";
const binding = ["agent", "server", "purpose"];

test("RFC 8452 C.2 AES-256-GCM-SIV known-answer vector", () => {
  const key = Buffer.alloc(32);
  key[0] = 1;
  const nonce = Buffer.alloc(12);
  nonce[0] = 3;
  const cipher = gcmsiv(key, nonce);
  assert.equal(
    Buffer.from(cipher.encrypt(new Uint8Array())).toString("hex"),
    "07f5f4169bbf55a8400cd47ea6fd400f",
  );
});

test("versioned base64 envelope round-trips and uses fresh nonces", () => {
  for (const value of ["", "secret-token", "Unicode 🦀", "x".repeat(20_000)]) {
    const first = sealSecret(value, binding),
      second = sealSecret(value, binding);
    assert.notEqual(first, second);
    assert.equal(openSecret(first, binding), value);
    assert.equal(openSecret(second, binding), value);
    assert.match(first, /^v1:/);
  }
});

test("tampering, truncation, wrong key, binding and plaintext fail closed", () => {
  const encrypted = sealSecret("do-not-leak-this-token", binding);
  const bytes = Buffer.from(encrypted.slice(3), "base64");
  for (const offset of [0, 12, bytes.length - 1]) {
    const changed = Buffer.from(bytes);
    changed[offset] ^= 1;
    assert.throws(
      () => openSecret(`v1:${changed.toString("base64")}`, binding),
      /Cannot decrypt credential/,
    );
  }
  for (const value of [
    "plain-token",
    "v2:" + encrypted.slice(3),
    encrypted.slice(0, -4),
    encrypted + " ",
  ]) {
    assert.throws(
      () => openSecret(value, binding),
      /Cannot decrypt credential/,
    );
  }
  for (const other of [
    ["other", "server", "purpose"],
    ["agent", "other", "purpose"],
    ["agent", "server", "other"],
  ]) {
    assert.throws(
      () => openSecret(encrypted, other),
      /Cannot decrypt credential/,
    );
  }
  const prior = process.env.APP_SECRET_KEY;
  process.env.APP_SECRET_KEY = "a-different-test-key-of-sufficient-length";
  try {
    assert.throws(
      () => openSecret(encrypted, binding),
      /Cannot decrypt credential/,
    );
  } finally {
    process.env.APP_SECRET_KEY = prior;
  }
});

test("accidental nonce reuse is supported without falling back to GCM", (t) => {
  t.mock.method(crypto, "randomBytes", () => Buffer.alloc(12, 7));
  syncBuiltinESMExports();
  try {
    const a = sealSecret("first-token", binding),
      b = sealSecret("other-token", binding);
    assert.notEqual(a, b);
    assert.equal(openSecret(a, binding), "first-token");
    assert.equal(openSecret(b, binding), "other-token");
    assert.equal(a, sealSecret("first-token", binding)); // Equality is the reuse leakage.
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("development default and production fail-closed configuration", () => {
  const key = process.env.APP_SECRET_KEY,
    env = process.env.NODE_ENV;
  try {
    delete process.env.APP_SECRET_KEY;
    process.env.NODE_ENV = "development";
    const dev = sealSecret("dev-token", binding);
    process.env.APP_SECRET_KEY = "restate";
    assert.equal(openSecret(dev, binding), "dev-token");
    process.env.NODE_ENV = "production";
    for (const bad of [undefined, "restate", "short", " ".repeat(64)]) {
      if (bad === undefined) delete process.env.APP_SECRET_KEY;
      else process.env.APP_SECRET_KEY = bad;
      assert.throws(() => sealSecret("token", binding), /APP_SECRET_KEY/);
      assert.throws(() => openSecret(dev, binding), /APP_SECRET_KEY/);
    }
    process.env.APP_SECRET_KEY = key;
    const good = sealSecret("production-test-token", binding);
    assert.equal(openSecret(good, binding), "production-test-token");
  } finally {
    process.env.APP_SECRET_KEY = key;
    if (env === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env;
  }
});

test("OAuth and PAT wire payloads contain only ciphertext and bind flow identity", () => {
  const tokens = {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    id_token: "test-id-token",
    token_type: "Bearer",
  };
  const clientInformation = {
    client_id: "test-client",
    client_secret: "test-client-secret",
    registration_access_token: "extension-secret",
  };
  const oauth = {
    serverId: "notion",
    redirectUrl: "https://example.test/callback",
    tokens,
    clientInformation,
  };
  const flow = {
    redirectUrl: oauth.redirectUrl,
    state: "test-state-nonce",
    codeVerifier: "test-pkce-verifier",
    tokens,
    clientInformation,
  };
  const stored = sealMcpOAuthState("agent", oauth);
  const sealedFlow = sealMcpOAuthFlow("agent", "notion", "request-1", flow);
  const credential = sealMcpToken("agent", "github", "test-pat-token");
  const payloads = [
    McpAuthorizationCompletionSchema.parse({
      expectedFlow: null,
      authRequestId: "a",
      oauthState: stored,
    }),
    McpAuthorizationFlowUpdateSchema.parse({
      expectedFlow: null,
      authRequestId: "b",
      flow: sealedFlow,
    }),
    McpBearerAuthorizationCompletionSchema.parse({
      authRequestId: "c",
      credential,
    }),
  ];
  const serialized = JSON.stringify(payloads);
  for (const secret of [
    ...Object.values(tokens),
    ...Object.values(clientInformation),
    flow.state,
    flow.codeVerifier,
    "test-pat-token",
  ])
    assert.ok(!serialized.includes(secret));
  assert.deepEqual(openMcpOAuthState("agent", stored), oauth);
  assert.deepEqual(
    openMcpOAuthFlow("agent", "notion", "request-1", sealedFlow),
    flow,
  );
  assert.equal(openMcpToken("agent", credential), "test-pat-token");
  assert.equal(openMcpToken("agent", stored), tokens.access_token);
  assert.throws(() =>
    openMcpOAuthFlow("agent", "notion", "request-2", sealedFlow),
  );
  assert.equal(
    McpAuthorizationCompletionSchema.safeParse({
      authRequestId: "a",
      oauthState: oauth,
    }).success,
    false,
  );
  assert.equal(
    McpBearerAuthorizationCompletionSchema.safeParse({
      authRequestId: "a",
      accessToken: "plaintext",
    }).success,
    false,
  );
  assert.equal(
    McpAuthorizationFlowUpdateSchema.safeParse({authRequestId: "a", flow})
      .success,
    false,
  );
});
