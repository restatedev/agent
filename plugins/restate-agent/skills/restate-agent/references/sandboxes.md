# Integrate sandbox compute

Use this reference when a request asks to run agent code on another compute
platform, change workspace persistence, or add a sandbox-backed tool. Paths
for `sandbox/...`, `tools/...`, and `agent-config.ts` are relative to
`packages/libs/core/src/`; `test/...` is relative to `packages/libs/core/`.
Read `docs/sandboxes.md` and `docs/agent-guide.md` for the current contract.

## Choose the seam

| Goal | Change |
| --- | --- |
| Use the existing demo workspace | Keep the default `local` provider; it runs as the service user and is not an isolation boundary. |
| Use the existing remote adapter | Configure `SANDBOX_PROVIDER=modal` and its credentials as described in `docs/sandboxes.md`. |
| Use Docker Sandboxes or another platform | Implement `SandboxProvider` in a new adapter and register it in `sandbox/provider.ts`. |
| Give the model another operation in its workspace | Extend `SandboxClient` and a built-in tool in `tools/sandbox.ts`; register the tool in `agent-config.ts`. |

`AgentSession` owns the sandbox, not `Agent` or a separate virtual object. It
stores a provider-tagged `SandboxRef` under the `sandbox` state key. The first
sandbox tool in a turn provisions or resumes compute; parallel first users
share that acquisition, and the turn suspends it on exit. A later turn
resumes the stored workspace. `AgentSession.retire` destroys it after the
active turn. Providers keep workspace files across turns; do not rely on
processes or ephemeral compute surviving suspension. If a product needs a
different lifetime, change `sandbox/turn.ts` explicitly; an adapter alone
cannot change when the turn acquires or releases compute.

## Add a provider

1. Add a discriminated, serializable variant to `SandboxRef` in
   `sandbox/provider.ts`. Store only the identifiers needed to reconnect to
   compute and persistent storage; keep credentials, SDK clients, and open
   handles process-local.
2. Implement `provision`, `resume`, `suspend`, `destroy`, and `connect` in an
   adapter beside `sandbox/local-provider.ts` and
   `sandbox/modal-provider.ts`. `connect` must only construct a client; it
   must not perform external I/O. Return a new ref when an operation changes
   the external identity.
3. Route new provisions from `SANDBOX_PROVIDER` and stored refs by their
   `provider` tag in `sandbox/provider.ts`. Changing the environment setting
   does not migrate existing workspaces; design a migration separately if
   existing agents must move.
4. Implement the `SandboxClient` file and command methods with workspace path
   containment and the supplied `AbortSignal`. Bound command runtime and
   clip model-visible results before journaling. Keep service credentials
   out of model-issued command environments. The local adapter is a
   development example, not a security boundary.
5. Leave acquisition, suspension, and retirement in `sandbox/turn.ts`.
   Tools obtain a client through `context.sandbox.client()`; do not put
   provider selection or lifecycle recovery into each tool.

For a Docker-backed adapter, decide which external identity names the
persistent workspace, what `suspend` preserves, and how `resume` reconnects
or replaces stopped compute. Use stable names or provider idempotency support
so a retry after an uncertain provision finds the same resource. Keep the
provider-specific answer in its adapter and ref rather than adding a
Docker-specific path to the turn loop.

## Add a sandbox-backed capability

The current `listFiles`, `readFile`, `writeFile`, and `executeCommand` tools
are in `tools/sandbox.ts`. When a new capability is useful across providers,
add it to `SandboxClient`, implement it in each adapter, then expose a
`defineAgentTool` that gets `context.sandbox.client()` and calls the client
method through `toolRun`. Add that tool to `agent-config.ts`. If a capability
exists only on one provider, decide how other providers report it before
advertising the tool to every agent. Keep model-visible output bounded before
it is journaled.

## Preserve replay and cancellation

`sandbox/turn.ts` wraps lifecycle operations in `restate.run`, and
`tools/sandbox.ts` wraps client calls in `toolRun`. Give each operation an
appropriate retry policy and pass its `AbortSignal` to the adapter. A remote
effect may finish before Restate records its result; replay can then repeat
it. Provision, suspend, resume, and destroy must recover or converge on the
same resource. Whole-file writes can be retried; arbitrary shell commands
cannot be assumed idempotent. The existing command tool makes one attempt
on a reported failure, but a crash before journaling can still repeat it.
For jobs that must not run twice, require provider-side idempotency with a
stable operation ID and a way to query its result on recovery.

Do not claim that aborting a tool necessarily kills a remote process. If
the provider cannot cancel an individual command, bound its runtime and
document what may continue until sandbox suspension or destruction.

## Verify the integration

Test adapter path containment, command environment, and resume after stale
compute in `test/sandbox.test.mjs` or a provider-specific test. Extend
`test/agent-deletion.test.mjs` for lazy first use, parallel acquisition,
interrupted first acquisition, later-turn resume, turn-end suspension, and
retirement. Exercise a restart around an uncertain external effect when
the provider has a recovery path. Update `docs/sandboxes.md` with the
provider's configuration, persistent storage semantics, and cancellation
limits.
