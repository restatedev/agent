# Add an application layer

The core reference starts from an `agentId`. `Agent` controls one conversation;
`AgentSession` runs its turns and stores its transcript. Ingress and the local UI
are operator-facing. To let people sign in, own several agents, and share MCP
connections, add an application layer around those two objects. This is an
extension pattern, not a description of services already in the repository.

## Separate the owners

| Layer | Proposed owner | Responsibility |
| --- | --- | --- |
| Conversation | Existing `Agent`, `AgentSession` | Active turn, profile and grants, approvals, transcript, tools, sandbox |
| Account | `User`, keyed by a stable user ID | Verified identity, owned-agent directory, encrypted MCP connections, optional shared memories and schedules |
| Browser session | `UserSession`, keyed by a hash of a random session ID | Expiry and revocation; no provider credentials |
| Workspace updates | `UserNotifications`, keyed by user ID | Revisions for account state and owned agents; no transcripts or secrets |
| Public edge | Web backend in `packages/apps/web/src/server/` | Login and OAuth callbacks, cookies, ownership checks, the only public route to private Restate ingress |

The account, browser session, and notification objects have different keys and
lifecycles. They need not be combined with `Agent`, whose lock must stay free
while a turn runs. Add only the objects the product needs; a single-user
customization can keep the existing operator model.

## Identity, ownership, and sessions

Use the identity provider's immutable issuer and subject to derive a stable
user key; an email address is display data, not an ownership key. The backend
validates the login response and derives `userId` from its authenticated
session, never from a browser request body. Keep Restate ingress and its auth
token private to the backend.

A `User` contract can start with `register`, `createAgent`, `ownsAgent`,
`profile`, and `snapshot`. It owns a directory of agent IDs and names.
`createAgent` initializes an agent with its immutable owner, then exposes it
in the directory. Make retries idempotent with an ID derived from the user and
a client-generated creation ID. Deletion first prevents the ID from being
recreated, then sends retirement without waiting for the agent's whole turn.

Add ownership to `agent/lifecycle.ts` and a guard in `agent/guards.ts`. Stop
implicit creation in `agent/start-turn.ts` once every agent must belong to a
user. Check ownership for every agent operation at the backend, including
history reads and child-agent operations. Child agents inherit the same owner;
the parent initiates their tasks, while the backend may expose only inspection,
approval, and interruption to the user.

For browser sessions, store a hash of a random session identifier as the
`UserSession` key. The cookie may contain sealed session claims; the backend
checks expiry and revocation before using them. A short validation lease can
reduce reads, but it creates a bounded revocation delay that the product must
choose deliberately. Bind the login callback to its initiating flow state,
and an MCP OAuth callback to the signed-in browser session that started it.
Validate state, nonce, and PKCE where the provider protocol requires them.

## Share MCP connections without exposing tokens

A user-owned connection can be offered to several agents, subject to each
agent's grants. Keep the OAuth redirect, callback, code exchange, and token
refresh at the backend boundary. Encrypt credentials **before** sending them
through Restate ingress: encrypting only state would still expose plaintext in
invocation inputs and journals. Store ciphertext and non-secret metadata in
`User`, keyed by account and connection/server ID. The backend and core service
need the same decryption key at runtime; neither the model nor the browser gets
it. Bind ciphertext to its user, connection, and purpose with authenticated
encryption, and plan for key rotation.

At turn start, have `agent/start-turn.ts` request an authorized `User.snapshot`
for that agent. Include allowed connection references and ciphertext in the
`doTurn` request, alongside the existing Agent profile snapshot. The turn uses
a stable snapshot rather than repeatedly reading mutable account state.
`session/mcp-tools.ts` decrypts an access token only inside the MCP HTTP
`restate.run` effect and never returns or logs it. Plaintext must not enter
durable arguments, state, signals, transcript, or model context. Decide how
revocation and rotation affect an already-running turn before implementing
this path. The existing operator-owned `MCP_SERVERS_JSON` mechanism remains a
separate configuration path; read `docs/mcp-configuration.md` for its current
security and replay rules.

A tool that changes user-owned state should call an internal `Agent` handler
with its trusted `turnId`. The Agent validates the live turn and tool grant,
then calls `User`, which validates agent membership before writing. Add the
owner ID to the trusted tool context instead of accepting it from model input.
This keeps one authorization route for direct tools and programmatic tool
calls.

## Send workspace updates without copying state

The existing UI captures an Agent revision, reads authoritative data, then
long-polls `Agent.watch`; notifications carry invalidation rather than data.
Extend that pattern one level up. `UserNotifications` receives one-way updates
for account changes and changes to owned agents. The backend reads a user
revision, fetches the owned-agent directory and selected agent state, then
watches for a later revision. Re-read only changed topics; page sequenced
`AgentSession.history` separately. A single user-level poll can therefore
update a workspace with many agents without transferring every transcript or
credential on each tick. Read `docs/protocol.md#history-and-notifications` and
`agent/notifications.ts` before adding fan-out.

## Decide what becomes user-wide

The current reference keeps memories and schedules per Agent. If memories
should be shared, move their ownership to `User` and let tools search an index
and read selected content. Avoid injecting the entire collection into every
turn. A user-wide schedule needs an explicit answer to where each firing goes:
the existing conversation, a chosen agent, or a fresh child agent. If it
creates a new agent, derive its ID from the schedule and occurrence so replay
cannot duplicate it; define busy policy, history, and cancellation separately.
Do not silently change the existing same-agent `Agent.fire` semantics.

## Keep cross-object calls safe

- Keep one lock order. An Agent handler may call User; do not create an
  exclusive User → Agent → User cycle. Start turns with one-way sends, and put
  any wait for a turn in a shared handler.
- Derive owner and parent IDs from durable state. Do not trust IDs supplied by
  tools, model output, or browser requests.
- Use deterministic IDs and idempotent handlers for agent creation, child
  creation, connection updates, and scheduled occurrences. External effects
  still need provider-side idempotency when a retry can repeat them.
- Keep account notification payloads to IDs, topics, and revisions. Fetch
  transcripts and credentials only from their authoritative owners.

## Integrate incrementally

1. Add the `User` contract and directory, immutable Agent ownership, and
   backend ownership checks. Update contracts in
   `packages/libs/types/src/services.ts` and clients in
   `packages/libs/client/src/`.
2. Add login and `UserSession` at the backend. Make the backend the only public
   caller of private ingress.
3. Add encrypted user MCP connections and the turn-start snapshot. Extend
   `session/mcp-tools.ts` without putting plaintext into durable values.
4. Add `UserNotifications` and a workspace sync endpoint if the UI needs to
   show several agents at once.
5. Move memories or schedules only when the product needs them shared.

At each step, update the affected UI operation, `docs/agent-guide.md` and
`docs/protocol.md`, and test authorization, replay, revoked access, and the
cross-object call order. Preserve unrelated agent behavior while adding the
new layer.
