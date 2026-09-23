# Pedagogical reference: history review and implementation scope

Reviewed on 2026-09-22 at `8ce77d5`. Work branch:
`codex/pedagogical-reference`, created from current `main`.

Implementation on this branch now retains a local conversation UI, per-agent
memories, parent-owned child bookkeeping and same-agent message schedules.
User accounts, browser sessions, leases, OAuth/token entry and stored credential
encryption have been removed. MCP uses operator endpoint configuration and
credential environment references resolved inside HTTP effects. The sections
below preserve the original history review and rationale; current behavior and
setup are documented in [the README](../README.md).

This is a forward simplification from main, preserving recent runtime fixes.
Use fresh Restate state; no existing app state has been migrated or deleted.

## What changed to support the standalone app

The main comparison is `git diff 6f0d8b4...8ce77d5`: 32 commits, 122 changed
files, 11,986 insertions and 2,995 deletions. This range mixes application work
with useful runtime improvements; those totals are not a measure of removable
application code.

| Commit(s) | Change | Consequence for simplification |
| --- | --- | --- |
| `d2ee660`, `9bd1952` — Sep 4, before the main comparison | Agent-managed MCP OAuth and authenticated MCP workflows | The pre-Sep-10 version already had OAuth complexity. Going back to it would not produce a minimal example. |
| `2adc383` — Sep 10 | Users, browser sessions, Google sign-in, account connections, ownership checks, credential encryption, and related UI/contracts | This was the main transition to an account-based application: 73 files changed. It also touched runtime behavior, so reverting the whole commit is a poor removal strategy. |
| `e70d291` — Sep 11 | Separate production BFF image publishing | Adds a second independently published GHCR image. The workflow builds and publishes; it does not deploy the application. |
| `75abf65`, `aa1b174` — Sep 12 | Batched BFF reads and ownership-scoped deletion | Adds application lifecycle and transport behavior around the agent protocol. |
| `6c44e77`, `eb56cee` — Sep 12 | User-wide memories, workspace caches, `UserNotifications`, default access to authorized connections | The account becomes a shared workspace used by runtime execution as well as the UI. |
| `7fe0e05`, `5d4e613` — Sep 12 | Encrypted browser-session and ownership leases, then stale-access renewal | Optimizes authenticated requests; introduces proof issuance, expiration, renewal, and browser propagation. |
| `22a347f`, `42389d9`, `8887984` — Sep 12 | Persistent child agents, durable delegation/follow-ups, and user-owned schedules creating fresh agents | Valuable durable execution examples now depend on the user directory, ownership, and shared configuration. |
| `45a684e`, `8ce77d5` — Sep 17 | Development login bypass, including production builds | Bypasses Google using a synthetic identity. It still registers a User and retains the account architecture. |

Other recent changes worth preserving include bounded model-output recovery
(`4bc5a13`), turn-local tool search (`1299f27`), strict tool-schema fixes, and
durable child-result handling. Start from current `main` and simplify forward.

## The dependencies that matter

`UserSession` and `AgentSession` serve entirely different purposes.
`UserSession` backs browser authentication and revocation. `AgentSession`
owns the conversation log and durable `doTurn` execution, and remains central
to the reference.

Former standalone-app entry path:

```text
Browser -> BFF -> login/session + ownership checks -> Agent
                    |                                |
                 UserSession                         +-> User.snapshot
                                                     +-> AgentSession.doTurn

AgentNotifications -> UserNotifications -> workspace sync -> Browser
```

Former implementation locations (some removed on this branch):

- `packages/apps/web/src/server/user-auth.ts` and `auth-tokens.ts`: Google
  login, cookies, five-minute validation leases, and ownership proofs.
- `packages/libs/core/src/user/service.ts`: account identity and directory,
  connector configuration, encrypted credentials, authorization waiters,
  child lifecycle, memory/schedule handlers, and the backing UserSession.
- `packages/libs/core/src/agent/service.ts`, `startTurn`: every turn requires
  an owner and calls `User.snapshot` for memories, grants, servers, and
  credentials. Removing the login screen does not remove this dependency.
- `packages/libs/core/src/session/mcp-tools.ts`, `requireConnection`: MCP
  calls validate the account connection generation before execution.
- `packages/libs/core/src/notifications/service.ts`: per-agent invalidations
  also resolve ownership and fan out to UserNotifications.
- `packages/libs/core/src/user/schedules.ts`: each occurrence initializes a
  fresh owned agent, then waits in a separate shared handler. Preserve this
  separation if retaining fresh-agent schedules; waiting under the same
  exclusive owner lock would introduce a callback deadlock.

## Proposed teaching scope

The reader should be able to start with an `agentId` and follow a request into
the controller, durable turn, model/tool execution, and conversation history
without first understanding account authentication.

Keep the controller/session separation, queue/steer/interrupt semantics,
append-only history and compaction, parallel tools and PTC, approvals and
guardrails, model gateway, sandbox lifecycle, and focused evaluations.

| Area | Proposed treatment |
| --- | --- |
| Google login, browser UserSession, cookies, authorization proofs | Remove from the local reference. |
| User ownership, account registration, shared account directory | Remove as prerequisites for ordinary agent creation and execution. Avoid retaining the same architecture under a renamed singleton User. |
| Memories | Return to agent-local memory if memory remains in the core example. This deliberately removes cross-agent sharing. |
| MCP | Keep tool discovery/execution with operator-configured endpoints. Prefer public demo endpoints or environment-backed credentials. |
| Account OAuth, token-entry UI, PKCE/refresh storage, shared authorization flows | Remove from the basic reference when replacing credential configuration. |
| Notifications and UI | Retain the per-agent notification stream and a small conversation UI. Remove the account-wide aggregation and access-proof plumbing. Keep a thin server adapter where needed. |
| Sub-agents | Preserve durable delegation semantics if included. Move retained parent/child bookkeeping out of the account directory; do not automatically discard the cancellation and follow-up fixes. |
| Schedules | Choose explicitly between a small per-agent scheduling example and the current fresh-agent-per-occurrence behavior. These are different semantics, not an invisible storage refactor. |
| Packaging | Keep enough packaging to run the example easily. The independent BFF publishing workflow can be removed if publishing a standalone app is no longer a goal. |

The local reference should declare its local/trusted execution boundary. It
should not continue to present itself as a public multi-user application after
its authentication layer has been removed.

## Credential encryption needs a replacement boundary

The same secrets package currently supports two distinct things:

1. Browser cookies and access proofs authenticate application access.
2. MCP credential encryption prevents access tokens, refresh state, and PKCE
   material from entering Restate invocation inputs, state, journals, and
   signals as plaintext.

Deleting login removes the first use, not the reason for the second. Current
MCP encryption occurs before Restate ingress, and token decryption happens
inside the HTTP `restate.run` closure.

For the proposed simpler MCP setup, durable configuration carries only an
endpoint identity and an operator-controlled credential reference. Resolve
the environment credential inside the external HTTP operation. Never pass the
resolved token through handler arguments, turn snapshots, model context, or a
`run` result. Retain ciphertext handling until stored credentials and all
their consumers have been removed; only then delete the secrets package.

## Suggested implementation order

1. Settle the retained examples: local UI versus scripts, schedules,
   sub-agents, and whether interactive OAuth is a teaching objective.
2. Replace account-managed MCP setup with explicit local configuration and
   resolve credentials only inside HTTP effects. Remove the corresponding
   OAuth/PAT browser flow and stored credential contracts together.
3. Move retained non-account state to its natural owner: agent memory,
   parent/child lifecycle, and the selected scheduling example. Preserve
   turn snapshots and the existing cancellation/locking invariants.
4. Make ordinary agent creation and `ask` independent of User. Simplify the
   browser/server adapter and notification path in the same change, then
   remove User, UserSession, UserNotifications, ownership leases, and unused
   clients/schemas. Keep intermediate changes coherent and runnable.
5. Remove obsolete dependencies, packaging, tests, and documentation.
   Rewrite the reading path around one complete request, followed by the
   advanced examples. Do not carry a permanent application/reference mode
   switch or add a generic identity-provider abstraction.

Use fresh local Restate state for this experimental branch. Compatibility
with the deployable app's stored ownership/credential formats is not a
proposed teaching requirement, and this plan does not delete existing data.

## Review findings and validation

*Historical, recorded against `main` before implementation.* Standards axis:
one documented-contract drift finding. `PROJECT.md` then described
agent-local memories and AgentScheduler, and `docs/README.md` a scheduler per
agent, while `main` kept both user-owned. This branch made those descriptions
true again by moving memories and schedules onto the agent. No runtime
standards violation was established in the focused inspection.

Spec axis: no confirmed violation in the reviewed identity/session,
ownership, and credential boundaries. The comparison used repository
behavioral documentation; no originating issue/spec was supplied. This is
not an exhaustive security audit or a live OAuth/provider test.

Baseline checks on 2026-09-22:

- Types, secrets, and client dependency builds passed.
- Secrets package tests: 6 passed.
- Core secrets/auth/user tests: 40 passed.
- Web tests: 48 passed.
- Full production build and live Restate/provider evaluations were not run
  for this history review.

For implementation, verify direct agent startup without Google configuration
or account registration, retained turn-control and replay behavior, absence
of plaintext credentials in recorded inputs/results, and every retained
schedule/delegation path. Run proportional build, bundle, and test checks.

## Implementation verification — 2026-09-23

- Workspace build, including the production Next.js build: passed.
- Biome lint, core bundle and `git diff --check`: passed.
- Deterministic core tests: 88 passed; web snapshot tests: 10 passed.
- New coverage checks direct startup without accounts, local memory isolation
  and atomic limits, child context/access inheritance, timer lifecycle,
  environment credential references, sanitized MCP failures and replay without
  repeated HTTP calls or journaled tokens.
- A disposable local Restate instance verified direct startup, independent
  memories, same-agent schedule delivery/cancellation, child input restrictions,
  idempotent retirement and missing-model-key terminal recovery.
- Browser verification covered connection without login, saving instructions,
  switching agents, memory display and the child view. Same-origin writes on
  `127.0.0.1` succeed; a different Origin is rejected.
- Live model generation and the full model-driven Evals suite were not run:
  `OPENAI_API_KEY` was absent from the process environment. Real remote MCP and
  Modal services were not exercised.

The disposable servers and Restate container were stopped after verification.
The implementation is on `codex/pedagogical-reference`.

## Review follow-ups — 2026-09-23

A review of the branch led to these fixes, one commit each: scheduled
deliveries are sent rather than awaited under the scheduler lock; model
schedule changes are authorized against the live turn; recurring runs
coalesce instead of stacking or interrupting their own turn; UI reads reject a
non-loopback Host (DNS rebinding); retirement clears profile, memories and
approvals; a successor that cannot start keeps its queued input; MCP discovery
retries transient failures inside its effect; `tokenEnv` must end in
`_MCP_TOKEN`; and the trust boundary is documented.

After these changes: deterministic core tests 94 passed; web tests 13 passed;
workspace build and Biome lint passed. Live model, MCP and Modal paths were
still not exercised.
