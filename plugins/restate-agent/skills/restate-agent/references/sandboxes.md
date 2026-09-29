# Integrate sandbox compute

Use this when a request asks to run agent code on another compute
platform, change how the workspace persists, or add a sandbox-backed tool.
Read `docs/sandboxes.md` and `docs/agent-guide.md` for the current
contract.

## Choose the seam

| Goal | Change |
| --- | --- |
| Use the demo workspace | Keep the default `local` provider. It runs as the service user and is not an isolation boundary |
| Use the existing remote adapter | Set `SANDBOX_PROVIDER=modal` and its credentials, as in `docs/sandboxes.md` |
| Use Docker Sandboxes or another platform | Implement `SandboxProvider` in a new adapter and route to it in `sandbox/provider.ts` |
| Give the model another operation in its workspace | Extend `SandboxClient` and add a tool in `tools/sandbox.ts`; list it in `agent-config.ts` |

## Who owns the sandbox

`AgentSession` owns the sandbox, not `Agent` and not a separate virtual
object. It stores a provider-tagged `SandboxRef` under the `sandbox` state
key.

- The first sandbox tool in a turn provisions or resumes the compute.
  Parallel first calls share that one acquisition.
- The turn suspends the sandbox when it ends. A later turn resumes the
  stored workspace.
- `AgentSession.retire` destroys it, after the active turn.
- Providers keep the workspace files across turns. Processes and ephemeral
  compute do not survive a suspension.

`sandbox/turn.ts` decides when compute is acquired and released. For a
different lifetime, change it there; an adapter alone cannot change it.

## Add a provider

1. Add a serializable variant, tagged by `provider`, to `SandboxRef` in
   `sandbox/provider.ts`. Store only the identifiers needed to reconnect to
   the compute and the storage. Keep credentials, SDK clients and open
   handles in the process.
2. Implement `provision`, `resume`, `suspend`, `destroy` and `connect` in an
   adapter next to `sandbox/local-provider.ts` and
   `sandbox/modal-provider.ts`.
   - `connect` only builds a client; it does no external I/O.
   - Return a new ref when an operation changes the external identity.
3. Route to the adapter in `sandbox/provider.ts`: new sandboxes by
   `SANDBOX_PROVIDER`, stored refs by their `provider` tag. **Update
   `providerFor`**: today it sends every tag other than `modal` to the local
   adapter, so a missing case fails silently.
4. Changing `SANDBOX_PROVIDER` does not move existing workspaces. If
   existing agents must move, design a migration.
5. Implement the `SandboxClient` file and command methods:
   - keep every path inside the workspace;
   - honor the `AbortSignal` passed in;
   - bound how long a command runs;
   - keep service credentials out of the environment of commands the model
     issues.
6. Leave acquisition, suspension and retirement in `sandbox/turn.ts`. Tools
   get a client through `context.sandbox.client()`; they never pick a
   provider or recover a lifecycle themselves.

For a Docker-backed adapter, decide:

- which external identity names the persistent workspace;
- what `suspend` preserves;
- how `resume` reconnects to, or replaces, stopped compute.

Use stable names or the provider's idempotency support, so a retry after an
uncertain provision finds the same resource. Keep the provider-specific
parts in its adapter and ref, not in the turn loop.

## Add a sandbox-backed capability

The current tools are `listFiles`, `readFile`, `writeFile` and
`executeCommand`, in `tools/sandbox.ts`. For a capability that is useful on
every provider:

1. Add it to `SandboxClient` and implement it in each adapter.
2. Add a `defineAgentTool` that gets `context.sandbox.client()` and calls
   the method inside `toolRun`.
3. Clip the model-visible output inside the run, before it is journaled,
   as `clipped()` in `tools/sandbox.ts` does.
4. Add the tool to `agent-config.ts`.

If a capability exists on only one provider, decide how the others report
it before offering the tool to every agent.

## Keep replay and cancellation safe

`sandbox/turn.ts` wraps the lifecycle operations in `restate.run`, and
`tools/sandbox.ts` wraps the client calls in `toolRun`.

- The lifecycle runs use the default retry policy. The tool runs use
  bounded ones: `IDEMPOTENT_RETRY` (three attempts) for file operations,
  and a single attempt for commands.
- A remote effect can finish before Restate records its result, and replay
  then repeats it. Provision, suspend, resume and destroy must therefore
  converge on the same resource.
- Whole-file writes are safe to retry. Shell commands are not assumed to
  be: `executeCommand` runs once and never retries a failed attempt, but a
  crash before its result is journaled can still run it again. (A non-zero
  exit code is a normal result, not a failure.)
- For a job that must never run twice, require provider-side idempotency:
  a stable operation ID, and a way to query its result on recovery.

Aborting a tool does not necessarily kill a remote process. If the
provider cannot cancel a single command, bound its runtime, and document
what may keep running until the sandbox is suspended or destroyed.

## Verify the integration

- **Adapter:** path containment, the command environment, and resuming
  after the compute went away. `test/sandbox.test.mjs` covers the local
  adapter's environment and path containment; add a test file for the new
  provider.
- **Lifecycle:** extend `test/agent-deletion.test.mjs` for lazy first use,
  parallel acquisition, an interrupted first acquisition, resuming in a
  later turn, suspension at turn end, and retirement.
- **Recovery:** when the provider has a recovery path, exercise a restart
  around an uncertain external effect.

Update `docs/sandboxes.md` with the provider's configuration, how its
storage persists, and its cancellation limits.
