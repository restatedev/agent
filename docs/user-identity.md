# Users, agents, and connections

The public boundary is the Next.js BFF. Restate ingress, Admin API, core
services, and tool services must remain private. This is a trusted-operator
application, not a sandbox for arbitrary internet users.

| Component | Responsibility |
| --- | --- |
| Google + BFF | Sign in, verify identity, manage browser cookies, enforce ownership and same-origin writes |
| User VO | Verified identity, agent directory, MCP connections and encrypted credentials/flows |
| UserSession VO | Expiry and revocation of a browser session, keyed by a hash of its opaque cookie |
| Agent VO | Immutable owner, one conversation, profile/tool grants, approvals and per-turn authorization actions |
| AgentSession.doTurn | Execute the snapshotted allowed tools; wait durably for authorization |

## Google setup

1. Create a Google OAuth client of type **Web application** and configure its
   consent screen/test users as appropriate.
2. Register the exact redirect URI:
   `http://localhost:3000/api/auth/callback` for local development, or
   `https://YOUR-HOST/api/auth/callback` for a deployment/tunnel.
3. Set these **server-only** BFF variables:

   ```dotenv
   APP_PUBLIC_URL=http://localhost:3000
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   # Optional: narrow access to individual restate.dev accounts.
   GOOGLE_ALLOWED_EMAILS=
   ```

4. Set the same `APP_SECRET_KEY` on BFF and core, then start the services,
   register the core deployment, and open the UI.

Only `openid email profile` is requested: **only restate.dev Google Workspace
accounts can sign in**, and **no inbox access** is granted. The BFF uses Google's official
library to verify ID-token signature, issuer, expiry and audience, and checks
the nonce and verified email. Identity keys derive from issuer + subject, not
an email address that can change. Google tokens stay in BFF memory.

The BFF requires the verified ID token's `hd` claim to equal `restate.dev`.
An email ending in `@restate.dev` is not sufficient without that Workspace
claim. The account chooser also receives an `hd=restate.dev` hint, but that
hint is not the security check. `GOOGLE_ALLOWED_EMAILS`, when set, further
narrows access within that domain; it never permits other domains. See
[Google's domain validation guidance](https://developers.google.com/identity/openid-connect/openid-connect#hd-param).

Login uses state, nonce, PKCE, and an encrypted ten-minute flow cookie. Browser
sessions last seven days and use HttpOnly, SameSite=Lax cookies (Secure on
HTTPS). Only a domain-bound SHA-256 hash of the random session cookie enters
Restate. Sessions issued before the domain restriction require a new sign-in;
their old lookup keys are no longer accepted, even if the cookie is reused.
Logout revokes that session; other browser sessions and running turns continue.
MCP callbacks must return to the same signed-in browser session that started
the flow.

`APP_PUBLIC_URL` is authoritative for login, MCP metadata/callback URLs and
CSRF checks. Do not rely on forwarded headers. Changing a tunnel URL requires
updating this variable, the Google client's redirect allowlist, and restarting
the BFF. Existing OAuth links should be started again.

Production requires HTTPS and a strong `APP_SECRET_KEY`. The restate.dev
Workspace restriction applies in every environment. `GOOGLE_ALLOWED_EMAILS`
is optional in both development and production.
`ENABLE_WEB_EVALS=true` explicitly enables authenticated public eval requests;
it defaults off. Internal ingress evals remain available to trusted operators.

## Account connections, agent grants

Use **Connections** in the sidebar to add presets/custom endpoints and authorize
OAuth or save a bearer token. Credentials and PKCE state are encrypted before
Restate ingress. A saved credential does not prove it is valid; **Discover
tools** checks the remote server.

Create an agent by name, then select tools in **Context → Tool access**:

```json
{
  "builtin": {"mode": "all"},
  "dynamic": {"mode": "selected", "names": ["Catalog/lookup"]},
  "mcp": [
    {"connectionId": "notion", "tools": {"mode": "selected", "names": ["search"]}},
    {"connectionId": "github", "tools": {"mode": "all"}}
  ]
}
```

Built-in selections use tool names. Dynamic selections use stable
`service/handler` identities. MCP selections use raw remote names, not their
qualified model aliases. “All” explicitly includes future discovered tools;
“selected” with an empty list grants nothing.

New agents allow built-ins, but no dynamic or MCP tools. The model catalog,
direct dispatcher and PTC child dispatcher enforce the same grants. Existing
guardrails and approvals still apply to the allowed concrete calls. Per-agent
changes publish profile invalidation and apply to the next turn.

Connections are shared only within a user. Config changes, removal or
disconnect bump a durable generation and cancel associated authorization flows;
already-running turns check that generation before starting another MCP call.
They cannot undo an HTTP request already sent. Disconnect deletes locally
stored credentials; revoke tokens at the provider as well when needed.

## Shared authorization

A turn asks its Agent for authorization. Agent records its pending action and
attaches a waiter to the User's connection flow. The BFF performs OAuth or
accepts a PAT. User stores ciphertext and sends completion to every attached
Agent, which signals only its matching active, non-interrupting turn.

Multiple agents share one pending flow per connection. Interrupting one removes
only its waiter. An expired flow can be restarted from Connections without
detaching the other waiters. Concurrent OAuth starts/completions compare their
encrypted flow versions; stale callbacks cannot overwrite newer credentials.
Refresh/registration/PKCE material never enters a turn. Only
`{serverId, encryptedToken}` crosses into the turn and its authorization signal.

## Limits and development state

There is no anonymous fallback, agent claiming, sharing, organization model,
agent transfer, or migration of old Agent-owned credentials. Use newly created
agents and reconnect accounts; no existing state is automatically deleted.
Each agent is one conversation, with its own sandbox and schedules.

Authorization is not process isolation. Local sandbox commands run with the
core process's OS privileges, dynamic handlers use their own server privileges,
and configured MCP endpoints are trusted outbound destinations. Restrict login
to trusted operators; use isolated sandbox providers and network egress policy
before considering mutually untrusted tenants.

Provider reference: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
and [ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
