// Node-only. Never import from browser code or return decrypted values from a
// Restate handler/run: those results are journaled. Encrypt at the BFF boundary.
import {hkdfSync, randomBytes} from "node:crypto";
import {gcmsiv} from "@noble/ciphers/aes.js";
import {
  type EncryptedSecret,
  EncryptedSecretSchema,
  type McpOAuthFlow,
  McpOAuthFlowSchema,
  type McpOAuthState,
  McpOAuthStateSchema,
  type McpStoredOAuthState,
  type McpTurnCredential,
} from "@restate-agents/types";

const DOMAIN = "restate-agents/app-secret/v1";
let cached: {secret: string; key: Uint8Array} | undefined;

function appKey(): Uint8Array {
  const secret = process.env.APP_SECRET_KEY ?? "restate";
  if (
    !secret.trim() ||
    (process.env.NODE_ENV === "production" &&
      (secret.trim() === "restate" || Buffer.byteLength(secret.trim()) < 32))
  ) {
    throw new Error(
      "APP_SECRET_KEY must be set to a strong secret (at least 32 bytes) in production; the restate default is development-only",
    );
  }
  if (cached?.secret !== secret) {
    cached = {
      secret,
      key: new Uint8Array(
        hkdfSync("sha256", secret, DOMAIN, "AES-256-GCM-SIV", 32),
      ),
    };
  }
  return cached.key;
}

/** Version + base64(nonce[12] || ciphertext || authentication tag[16]). */
export function sealSecret(
  plaintext: string,
  binding: readonly string[],
): EncryptedSecret {
  const key = appKey();
  const nonce = randomBytes(12);
  const ciphertext = gcmsiv(key, nonce, associatedData(binding)).encrypt(
    Buffer.from(plaintext, "utf8"),
  );
  return EncryptedSecretSchema.parse(
    `v1:${Buffer.concat([nonce, ciphertext]).toString("base64")}`,
  );
}

export function openSecret(
  encrypted: EncryptedSecret,
  binding: readonly string[],
): string {
  const key = appKey();
  try {
    const encoded = EncryptedSecretSchema.parse(encrypted).slice(3);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length < 28 || bytes.toString("base64") !== encoded)
      throw new Error();
    const plaintext = gcmsiv(
      key,
      bytes.subarray(0, 12),
      associatedData(binding),
    ).decrypt(bytes.subarray(12));
    return Buffer.from(plaintext).toString("utf8");
  } catch {
    // Do not leak ciphertext, key, plaintext, or provider data in durable errors.
    throw new Error(
      "Cannot decrypt credential: check APP_SECRET_KEY and credential binding; reconnect if stored data is obsolete",
    );
  }
}

function associatedData(binding: readonly string[]): Uint8Array {
  return Buffer.from(JSON.stringify([DOMAIN, ...binding]), "utf8");
}

export function sealMcpToken(
  userId: string,
  serverId: string,
  token: string,
): McpTurnCredential {
  if (!token.trim()) throw new Error("MCP access token must not be empty");
  return {
    serverId,
    encryptedToken: sealSecret(token, [userId, serverId, "mcp-token"]),
  };
}

export function openMcpToken(
  userId: string,
  credential: McpTurnCredential,
): string {
  return openSecret(credential.encryptedToken, [
    userId,
    credential.serverId,
    "mcp-token",
  ]);
}

export function sealMcpOAuthState(
  userId: string,
  state: McpOAuthState,
): McpStoredOAuthState {
  const parsed = McpOAuthStateSchema.parse(state);
  return {
    ...sealMcpToken(userId, parsed.serverId, parsed.tokens.access_token),
    encryptedState: sealSecret(JSON.stringify(parsed), [
      userId,
      parsed.serverId,
      "mcp-oauth-state",
    ]),
  };
}

export function openMcpOAuthState(
  userId: string,
  state: McpStoredOAuthState,
): McpOAuthState {
  const parsed = McpOAuthStateSchema.parse(
    JSON.parse(
      openSecret(state.encryptedState, [
        userId,
        state.serverId,
        "mcp-oauth-state",
      ]),
    ),
  );
  if (parsed.serverId !== state.serverId)
    throw new Error("MCP OAuth server binding does not match");
  return parsed;
}

export function sealMcpOAuthFlow(
  userId: string,
  serverId: string,
  authRequestId: string,
  flow: McpOAuthFlow,
): EncryptedSecret {
  return sealSecret(JSON.stringify(McpOAuthFlowSchema.parse(flow)), [
    userId,
    serverId,
    "mcp-oauth-flow",
    authRequestId,
  ]);
}

export function openMcpOAuthFlow(
  userId: string,
  serverId: string,
  authRequestId: string,
  flow: EncryptedSecret,
): McpOAuthFlow {
  return McpOAuthFlowSchema.parse(
    JSON.parse(
      openSecret(flow, [userId, serverId, "mcp-oauth-flow", authRequestId]),
    ),
  );
}
