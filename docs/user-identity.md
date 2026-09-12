# Users, agents, and connections

The public boundary is the Next.js BFF. Restate ingress, Admin API, core
services, and tool services must remain private. This is a trusted-operator
application, not a sandbox for arbitrary internet users.

| Component | Responsibility |
| --- | --- |
| Google + BFF | Sign in, verify identity, manage browser cookies, enforce ownership and same-origin writes |
| User VO | Verified identity, agent directory, shared memories, MCP connections and encrypted credentials/flows |
| UserNotifications VO | Per-user revision feed for shared state and every owned agent; no transcripts or credentials |
| UserSession VO | Backing session expiry/revocation, keyed by a hash of a random session identifier |
| Agent VO | Immutable owner, one conversation, profile/tool grants, approvals and per-turn authorization actions |
| AgentSession.doTurn | Execute the snapshotted allowed tools; wait durably for authorization |

## Shared memories

Every new turn includes the current agent's display name from its ownership
state as model-context metadata, distinct from the user identity. It is not an
instruction or permission grant, and is not written into shared memories.

Memories belong to the user, not an agent. At each turn start, Agent fetches
`User.snapshot` and passes the entire memory collection to `AgentSession.doTurn`.
There is no memory search or per-agent selection. Already-running turns retain
their original snapshot; newly started turns see the latest saved memories.

`manageMemory` goes through Agent's active, non-interrupting turn check and then
`User.updateMemory({agentId, changes})`. User verifies membership and serializes
keyed changes, preserving unrelated updates from other agents. The collection
is limited to 32 entries; corrections to the same key use the last accepted write.

The prompt encourages relevant personalization and selective end-of-turn saves:
ongoing projects, useful decisions, and stable preferences, not an automatic
summary of every conversation. Memories are context data, never instructions.

The user **Profile & connectors** page has a collapsed **Memories** section, refreshed through
the shared workspace notification feed. Ask any agent to remember,
correct, or forget something. Deleting an agent does not delete user memories.
Old agent-local memory state is left untouched but is not automatically migrated
or injected into new turns.

## Sub-agents

A child is a normal agent owned by the same user, with immutable `parentAgentId`
in its ownership state and the User's directory. It has its own AgentSession,
approvals and sandbox keyed by its new ID; schedules remain user-owned. The sidebar nests children
under their parent, supports collapsing, and keeps per-agent unread state and
conversation caches. Sub-agents are not a new authorization principal.

`createSubAgent` inherits a creation-time copy of the parent's instructions,
guardrails and active-turn tool grants. Additional guardrails cannot replace
inherited IDs, tool access can only narrow, and disabled web search cannot be
enabled by the tool. Parent configuration edits do not propagate afterward.
Child conversations are read-only for users except Interrupt, enforced by the
BFF as well as the UI. Only their parent can submit tasks and follow-ups.
Children share the owner's
memories and authorized credentials through the existing User snapshot, not
through copies of secrets in their profile. Their MCP grants use
`mcpDefault: "disabled"`, so newly connected services require explicit opt-in;
ordinary agents retain default-on authorized connections. Revoked connections
remain unavailable. Child creation is currently limited to one level.

The Agent derives owner and parent IDs from durable ownership, checks its active
turn/tool permission, then calls that owner's User object. User checks parent
membership and initializes the child before exposing it. The parent session
then asks its Agent VO to start a delegated child turn. The controller validates
the same-user/direct-child relationship, starts the turn and records its ID.
The parent session attaches to that invocation and waits durably for its result;
the controller lock is free for Interrupt throughout execution. `messageSubAgent`
reuses this path for follow-ups in the same child's history and sandbox.
No parent lock is reacquired from
User, and child initialization does not call User. Creation/deletion publishes
the existing user-level profile notification; the BFF's ownership checks apply
to children exactly as to other agents.

Parent interruption and turn completion stop outstanding delegated tasks;
each tool also cleans up its wait, including losing PTC branches. Cleanup targets
the exact child turn, is idempotent, and cannot interrupt a newer follow-up.
Child failures and interruptions become tool errors for the waiting parent.
Completed children are retained for follow-ups, with normal sandbox lease
release/idle policy; journal expiry does not delete children.

Deleting a top-level agent from the UI deletes all its descendants. The parent can also
call `deleteSubAgent`, limited to its own direct children and their subtrees—not
siblings, unrelated agents, itself, or another user's agents. User serializes
directory removal with creation, tombstones every removed ID, removes pending
authorization waiters and durably sends retirement to each agent. Cleanup is
asynchronous: turns interrupt and borrowed sandboxes are
destroyed after release. Completed deletion cannot be undone by a delayed create
retry. Shared user credentials and memories survive. Conversation records remain
internally; this operation is not a data-purge API.

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
HTTPS, host-only, Path=/). The cookie contains AES-256-GCM-SIV authenticated,
encrypted claims: user ID, backing session ID, issuance time, five-minute
validation deadline and absolute expiry. It contains no provider credentials.
The backing session ID is a domain-bound SHA-256 hash of a random identifier.
Cookies are bound to the configured application origin and allowed-login policy.
Old random-handle cookies require a fresh sign-in after this format change.

The BFF verifies fresh cookies locally, without a `UserSession.read` RPC. Once
the five-minute lease expires, it reads the backing session, rejects revoked or
expired sessions, and renews the cookie without extending the seven-day absolute
expiry. Server-rendered pages may validate but cannot set cookies; the next API
request renews them. No browser refresh endpoint or extra browser round trip is
needed. Invalid ciphertext fails closed without a backing lookup.

Agent ownership also uses five-minute encrypted proofs. Workspace sync returns
an opaque `authorization` value containing the owned directory. The UI keeps it
in workspace memory and sends it back unchanged. Agent requests can carry it in
`x-workspace-access`, or reuse the smaller per-agent `x-agent-access` proof returned
by the BFF. Missing/expired proofs cause an authoritative directory/ownership
read in the same request. Large directories use the per-agent proof to avoid
proxy header-size limits; directories over 100 agents keep authoritative reads
instead of issuing a workspace proof. Proofs are bound to user, login session, origin,
purpose, and (for per-agent proofs) agent ID; none outlive session validation.
They do not replace the required session cookie. No authorization proof belongs
in a URL or local storage. Directory-change notifications force a fresh profile
read even when the cached directory proof is still valid.

**Revocation tradeoff:** logout clears this browser's cookie and revokes its
backing session, but a copied valid cookie/proof can authorize new requests for
up to five minutes. Deletion/access changes have the same maximum lease window
for direct requests; directory notifications update the normal UI sooner.
Already admitted operations can finish. Immediate revocation would require an
authoritative check on every request (or a separate revocation mechanism).
Other browser sessions and running turns continue.
MCP callbacks must return to the same signed-in browser session that started
the flow; lease renewal preserves that session ID.

All BFF replicas must share `APP_SECRET_KEY` and the public-origin/login-policy
configuration. The existing strong production key is reused with purpose-bound
authenticated data; no new environment variable or auth cache service is needed.
Rotating the key invalidates these cookies and proofs (and also affects stored
credentials encrypted with that key).

`APP_PUBLIC_URL` is authoritative for login, MCP metadata/callback URLs and
CSRF checks. Do not rely on forwarded headers. Changing a tunnel URL requires
updating this variable, the Google client's redirect allowlist, and restarting
the BFF. Existing OAuth links should be started again.

Production requires HTTPS and a strong `APP_SECRET_KEY`. The restate.dev
Workspace restriction applies in every environment. `GOOGLE_ALLOWED_EMAILS`
is optional in both development and production.
Evals are not exposed through the BFF or web UI. They remain available only
through trusted internal Restate ingress.

## Account connections, agent grants

The **Agents** sidebar shows a **New** badge when a turn finishes with a new
response. One user-level long poll returns changed completion cursors alongside
conversation and account updates. Unopened agents do not download conversation
history; visited agents keep their conversation and UI state cached. The badge clears
once that response is loaded in the focused, visible conversation. Switching
agents, reconnecting and refreshing preserve unread status. Read receipts
are scoped to the user and agent in browser local storage and synchronized
across tabs; they are not shared across devices. If browser storage is blocked,
receipts fall back to memory for that page lifetime. This is an in-app indicator,
not an OS notification or a browser-permission prompt.

### Workspace synchronization and isolation

`POST /api/user/sync` accepts cache revisions, an optional opaque authorization
proof and up to 100 agent cursors,
never a user ID, session ID, service name, or arbitrary handler. The BFF derives
the notification key from the authenticated cookie/session, checks every
requested agent against that User's authenticated directory proof (or an
authoritative directory read when absent/expired) before any agent read, and rejects
mixed owned/foreign IDs. It rechecks the session after waiting and before
releasing data. Feed entries never confer ownership: reads enumerate only the
authenticated directory, and deleted agents are removed from the response/cache.
Responses use `Cache-Control: private, no-store`; same-origin checks also apply.

Browser caches belong to one mounted user workspace, not module-global state
or local storage. Logout/session loss clears loaded data; an account change
remounts the workspace. Read receipts are persisted under user-scoped keys.
Switching agents retains drafts and expanded transcript details. Hidden views
never mark responses as read. A page refresh rebuilds the cache from the server.

The selected agent lives in React state, with only its ID remembered in
user-scoped `sessionStorage` for this tab. Refresh restores it only if it is
still in the authenticated user's agent directory; deleted or foreign IDs are
discarded. Choosing **Profile & connectors** clears the remembered selection.
Blocked browser storage falls back to in-memory navigation. Agent switching
does not change the URL or create browser history entries. Incoming `?agent=`
links (including OAuth returns) are consumed once and removed from the address
bar, preserving other query parameters and the hash. Stored selection is a UI
preference, never authorization; all BFF ownership checks remain in place.

The BFF holds no process-local cross-request authorization or conversation cache;
authorization leases travel encrypted through the browser. Restate
ingress (including UserNotifications and AgentSession) must remain private;
internal handlers trust the BFF/operator and are not public authentication APIs.

Use **Profile & connectors** in the sidebar to add presets/custom endpoints and authorize
OAuth or save a bearer token. Credentials and PKCE state are encrypted before
Restate ingress. A saved credential does not prove it is valid; **Test
connection** checks the remote server.

Create an agent by name, then use **Context → Tool access**:

- Authorize connections once on the account's **Profile & connectors** page.
- Authorized connections are enabled automatically at every new turn, including
  newly authorized accounts and newly discovered tools. No per-agent opt-in is needed.
- Each agent has one on/off switch per connection. Off saves an explicit empty
  selection, without disconnecting the account or changing other agents. That
  opt-out survives later turns and reconnects. On grants all of its tools again.
- Unauthenticated connections link back to **Profile & connectors** for authorization.
- Built-in and dynamic tools have compact name-only switches in expandable
  groups. No per-agent discovery step, access-mode dropdown, or tool-description
  list is required. Changes apply to the next turn.

The underlying grant contract still supports explicit selections for API clients:

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

New agents allow built-ins and their owner's authorized MCP connections, but
no dynamic tools. An omitted MCP entry defaults to all only when User resolves
the turn snapshot; an explicit selection still restricts it. Connections without
credentials are excluded unless they require no authentication. The model catalog,
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
Each agent is one conversation, with its own sandbox; schedules belong to the user.

Authorization is not process isolation. Local sandbox commands run with the
core process's OS privileges, dynamic handlers use their own server privileges,
and configured MCP endpoints are trusted outbound destinations. Restrict login
to trusted operators; use isolated sandbox providers and network egress policy
before considering mutually untrusted tenants.

Provider reference: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
and [ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
