# Growing the reference into a full application

The reference starts every request from an `agentId`, with no accounts or
logins, and trusts ingress and the local UI. A multi-user product adds an
**app layer** on top: users who own agents, browser sessions, per-user
credentials, and a backend that is the only public entry point.

The `agent-webapp` branch of `restatedev/agent` is a complete worked
example. Its head, commit `8ce77d5`, is in this repository's history, so
read its files directly:

```sh
git show 8ce77d5:packages/libs/core/src/user/service.ts
git show 8ce77d5:docs/user-identity.md
git ls-tree -r --name-only 8ce77d5 packages/apps/web/src/server
```

The reference later dropped that layer to stay small
(`git show 3b6b2e8 --stat`). The agent core has changed since, so port the
pattern, not the code.

## The layers

| Layer | Objects | Owns |
| --- | --- | --- |
| Agent (this repo) | `Agent`, `AgentSession` | One conversation: turns, transcript, profile, approvals, tools |
| App | `User`, `UserSession`, `UserNotifications` | Identity, which agents a user owns, user-wide memories and connections, credentials, browser sessions |
| Edge | The web backend (`packages/apps/web/src/server`) | Login, session cookies, ownership checks, the only route to ingress |

### `User`, keyed by a stable user ID

The account aggregate. Derive its key from the identity provider:
`sha256(JSON.stringify([issuer, subject]))`.

- **State:** `identity`, and an `agents` directory of
  `{agentId, name, parentAgentId?}`. Optionally also user-wide memories,
  MCP `connections` with encrypted credentials, and schedules.
- **Exclusive handlers:**
  - `register(identity)`, which rejects a changed issuer or subject;
  - `createAgent({agentId, name})`, which calls
    `Agent.initialize({ownerUserId, name})` and then adds the agent to the
    directory;
  - `deleteAgent`, which tombstones the agent and does a one-way
    `Agent.retire`.
- **Shared handlers:**
  - `profile`;
  - `ownsAgent(agentId)`;
  - `snapshot({agentId, tools})`, the per-turn view that an agent's turn
    reads (see the seams below).

### `UserSession`, keyed by a hashed session token

A browser session is `{userId, expiresAt}`, keyed by a domain-bound SHA-256
of a random token, so the raw token never enters Restate.

- `create` returns 409 if the session already exists.
- `read` is shared and returns null once the session has expired.
- `revoke` ends the session.

The backend seals `{userId, sessionId, validUntil}` into the cookie and calls
`read` only when that short lease (five minutes) runs out, so revocation
takes effect within that window.

### `UserNotifications`, keyed by user ID

It has the same watch/subscribe shape as the Agent's notifications, one
level up. `Agent.publish(topic)` also makes a one-way send of
`UserNotifications.publish({agentId, topic})` to its owner. The owner comes
from the agent's own `ownership` state, never from a caller-supplied ID.
The feed carries only revisions. One long poll then tells the UI which of
the user's agents changed.

## The seams to add to the agent

Each seam is small and sits in the module that already owns the concern:

1. **Ownership, set once.**
   - Add `ownerUserId` to the agent's metadata. Only `Agent.initialize`
     sets it (`agent/lifecycle.ts`), and a second call with another owner
     fails with 409.
   - Add a guard, `requireOwner()`, to `agent/guards.ts`.
   - Remove the implicit creation in `startTurn`, so an agent runs only
     after its user created it.
2. **The turn snapshot.** In `agent/start-turn.ts`, read
   `User.snapshot({agentId, tools})` before `activeTurn.start`. Pass what it
   returns into `AgentTurnRequest`:
   - `ownerUserId`;
   - the resolved MCP servers and their encrypted credentials;
   - user-wide memories, if you move them to the user.

   The turn then reads the snapshot, never live user state, just as it does
   the profile today.
3. **Owner-scoped tools call through the Agent.**
   - The tool calls an internal `Agent` handler with its `turnId`.
   - The Agent checks the live turn and its grant, then calls
     `User.X({agentId, ...})`.
   - `User` checks that `agentId` is in its directory.
   - Add `ownerUserId` to `AgentToolContext`, so tools that must reach the
     user do not trust model input.
4. **Credentials, sealed at the edge.**
   - The backend encrypts a token before it calls ingress, so plaintext
     never reaches invocation inputs, journals, state or signals.
   - Use an AEAD, for example AES-256-GCM-SIV with a key derived by HKDF,
     with associated data bound to `[userId, serverId, purpose]`. See
     `8ce77d5:packages/libs/secrets/src/index.ts`.
   - The MCP call opens the token only inside the HTTP `restate.run` body
     (`session/mcp-tools.ts`), and never returns it from the run.
5. **Notifications fan out** from `agent/notifications.ts` to
   `UserNotifications` with one-way sends.

## Rules that keep it correct

- **One lock order.**
  - Agent → User is allowed; User → Agent → User on an exclusive path
    never is.
  - `Agent.initialize` never calls `User`.
  - Retirement and deletion are one-way sends.
  - Waiting for an agent's turn from `User` happens in a shared handler.
    For example, `8ce77d5`'s `executeSchedule` waits in a shared handler,
    because the turn itself calls back into `User`.
- **Deterministic IDs make retries idempotent:**
  - an agent: `sha256([userId, creationId])`, where `creationId` is a UUID
    the browser generates;
  - a child: `sha256(["sub-agent", owner, parent, turnId, toolCallId])`;
  - a scheduled run: `sha256(["schedule-run", userId, scheduleId, occurrenceInvocationId])`.
- **Identity comes from the session.** The backend takes `userId` from the
  session cookie, never from the request body.
- **Every agent ID is checked.** Before touching an agent, check it against
  the user's directory: `User.ownsAgent`, or a short-lived sealed proof that
  the backend issued. An agent the user does not own is a 404.
- **Ingress stays private.** Only the backend holds `RESTATE_AUTH_TOKEN`.
  Hide 5xx details from the browser.
- **Child agents are read-only to users**, except for interrupt; the parent
  turn drives them (`8ce77d5:packages/apps/web/src/server/agent-mutation-policy.ts`).

## Build order

1. Add `User` with `register`, `createAgent`, `ownsAgent` and `profile`. Add
   the ownership seam in `Agent.initialize`, and serve `User` from
   `src/app.ts`.
2. Add `UserSession` and a login route to the backend: OIDC with state,
   nonce and PKCE, and a sealed session cookie. Scope every
   `/api/agent/[agentId]/...` route by ownership.
3. Add `UserNotifications` and a user-level sync route, so the UI can watch
   all of a user's agents at once.
4. Move whatever should be per-user, not per-agent, into `User`:
   memories, connections with sealed credentials, schedules. Feed each one
   to turns through `User.snapshot`.

At each step:
- add the typed contract to `packages/libs/types/src/services.ts` and a
  client to `packages/libs/client`;
- update `docs/agent-guide.md`, whose first invariant says no account
  service exists;
- write protocol tests for the ownership checks.

Files on `8ce77d5` to read for each part:

| Part | Files |
| --- | --- |
| User, schedules, memory | `packages/libs/core/src/user/{service,schedules,memory}.ts` |
| Notifications fan-out | `packages/libs/core/src/notifications/{service,user}.ts` |
| Agent ownership and turn snapshot | `packages/libs/core/src/agent/service.ts` (`initialize`, `startTurn`) |
| MCP authorization requests | `packages/libs/core/src/agent/mcp-authorization.ts` |
| Contracts and clients | `packages/libs/types/src/{services,targets}.ts`, `packages/libs/client/src/user.ts` |
| Sealed secrets | `packages/libs/secrets/src/index.ts` |
| Backend auth, proofs and sync | `packages/apps/web/src/server/{user-auth,auth-tokens,restate,workspace-sync,agent-mutation-policy}.ts` |
| Design notes | `docs/user-identity.md`, `docs/credential-encryption.md`, `docs/schedules.md` |
