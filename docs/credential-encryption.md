# Credential encryption

MCP OAuth credentials, bearer tokens (PATs/API keys), and redirect-round-trip
state are encrypted by the BFF **before entering Restate**. Encrypting only VO
state would leave plaintext in invocation inputs and signals.

The Node-only `@restate-agents/secrets` package uses
[`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers), pinned to 2.4.0,
and AES-256-GCM-SIV ([RFC 8452](https://www.rfc-editor.org/rfc/rfc8452.html)).
Noble has an independent Cure53 audit of version 1.0.0, not every later release.
GCM-SIV tolerates accidental nonce reuse; we still generate a fresh random
96-bit nonce for each encryption. It does not eliminate key-compromise risk,
usage limits, or the need to rotate a compromised key. Reusing a nonce can
reveal equality of identical messages.

## Configuration

Set the **same** `APP_SECRET_KEY` on the core service and Next.js BFF, including
all replicas. Never use a `NEXT_PUBLIC_` variable for this key.

- Outside `NODE_ENV=production`, an unset variable defaults to `restate` for
  the demo. This public default provides no real confidentiality.
- In production, missing, blank, `restate`, or fewer than 32 UTF-8 bytes are
  rejected when encryption/decryption is used. Length is not entropy: use a
  random secret, supplied through your deployment secret manager.
- Generate a suitable value with `openssl rand -base64 32`, then provision the
  same value in both processes. Do not commit it or place it in a profile.

HKDF-SHA-256 derives a domain-separated 256-bit key from the exact environment
value. HKDF is not password hardening. Keep the key stable across restarts;
losing or changing it makes existing ciphertext, including retained journals,
unreadable. This version has no key ring or automatic rotation/migration.

## Stored shape and ownership

Each encrypted value is a string:

```text
v1:<base64 of nonce[12 bytes] || ciphertext || authentication tag[16 bytes]>
```

Authenticated associated data binds the version/domain, User ID, MCP server
ID, and purpose. OAuth flows also bind the authorization request ID. Wrong
keys, tampering, and mismatched bindings fail closed without plaintext fallback.

- BFF encrypts full OAuth state (access/refresh/ID tokens, client secrets, SDK
  extension fields) and flow state (PKCE verifier and state nonce included).
- User stores `{serverId, encryptedToken, encryptedState}` for OAuth and
  `{serverId, encryptedToken}` for bearer credentials. Encrypted flow blobs
  are stored alongside their authorization request IDs.
- Agent only copies ciphertext. Turn inputs and authorization signals receive
  `{serverId, encryptedToken}`, never refresh tokens or OAuth flow blobs.
- BFF decrypts OAuth state in memory for the SDK. MCP execution decrypts the
  access token inside the HTTP `restate.run` body; it never returns that token
  or the authorization header from the run.
- Public user/profile and pending-authorization reads still expose no credentials.

Encryption randomness runs in the BFF, outside durable handlers. User state
transitions and replay reuse ciphertext recorded at ingress; they do not
generate nonces or re-encrypt on replay.

## Existing data and boundaries

This is a breaking credential wire/state format, with no plaintext read
fallback. Use fresh development state and reconnect MCPs before testing;
finish/cancel old-code turns before deploying. No existing data is deleted or
rewritten automatically. Encrypting new writes cannot erase old plaintext
from retained journals, snapshots, backups, or logs.

This protects application-managed MCP secrets in Restate, not all application
data. It does not encrypt history or arbitrary tool results, protect secrets
pasted into chat, replace HTTPS/access control, or hide values from a process
holding the key. Provider keys (`OPENAI_API_KEY`, Modal credentials, Restate
ingress/admin tokens) remain server environment configuration; they are not
copied into Agent state.

## Verification

```sh
pnpm --filter @restate-agents/secrets... --filter @restate-agents/client... build
pnpm --filter @restate-agents/secrets test
pnpm --filter @restate-agents/core test:secrets
```

Tests use synthetic credentials and mock providers. Coverage includes an RFC
known-answer vector, repeated nonces, tampering/binding checks, production
configuration, OAuth/PAT state and signals, next-turn projection, and MCP HTTP
headers with journal replay.
