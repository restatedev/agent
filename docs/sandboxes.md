# Sandbox lifecycle and provider contract

The sandbox is the agent-scoped **tool execution environment** and persistent
workspace. Files created in one agent run remain available to later runs for
the same `agentId`. It is an external resource owned by the runtime, not agent
memory or model context.

`Sandbox` owns durable lifecycle. `SandboxProvider` owns vendor operations.
Tools consume only `SandboxClient`.

## Ownership model

`Sandbox` is a Virtual Object keyed by the same `agentId` as `Agent`. Its state
is one of:

```ts
type SandboxState =
  | {status: "borrowed"; ref: SandboxRef; turnId: string}
  | {status: "idle"; ref: SandboxRef; timerId: string}
  | {status: "suspended"; ref: SandboxRef};
```

The resource belongs to the Agent, while one turn at a time may borrow it.
Agent serialization already guarantees one active turn, and Sandbox validates
the borrower explicitly.

The turn does not provision eagerly. The first sandbox tool lazily calls
`Sandbox.borrow`. Parallel tools share one in-flight borrow future, and later
steps reuse the resolved reference. `AgentSession.doTurn` releases the lease when it exits,
including cancellation paths.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> Borrowed: first sandbox tool / provision
  Suspended --> Borrowed: borrow / resume
  Idle --> Borrowed: borrow / cancel idle timer
  Borrowed --> Idle: turn release / schedule suspension
  Idle --> Suspended: idle timer fires / suspend
  Idle --> [*]: destroy
  Suspended --> [*]: destroy
```

The default idle delay is five minutes.

### `borrow({turnId})`

- Repeated borrow by the same turn is idempotent and returns the current ref.
- A different turn cannot borrow an already borrowed resource.
- An idle suspension timer is cancelled before reuse.
- Missing state provisions a new sandbox.
- Suspended state resumes compute and persists the provider's updated ref.

### `release({turnId})`

- Only the current borrower changes state.
- Repeated or stale release is a no-op.
- Release schedules a delayed self-send to `suspend` and stores its invocation
  ID.
- A later borrow cancels that delayed invocation.

### `suspend()`

The delayed invocation acts only when its invocation ID still matches the
stored idle timer. This rejects stale timers after a borrow/release cycle. The
provider may return an updated ref—for example, one with no live compute ID.

### `destroy()`

Destroy is rejected while borrowed. From idle or suspended state it cancels an
idle timer when needed, asks the provider to destroy external resources, then
clears VO state.

`borrow`, `release`, `suspend`, and `destroy` are coordination handlers, not
normal conversation APIs.

## Provider boundary

The vendor-neutral interface is:

```ts
interface SandboxProvider {
  provision(options: {
    agentId: string;
    signal: AbortSignal;
  }): Promise<SandboxRef>;

  suspend(
    ref: SandboxRef,
    options: {signal: AbortSignal},
  ): Promise<SandboxRef>;

  resume(
    ref: SandboxRef,
    options: {signal: AbortSignal},
  ): Promise<SandboxRef>;

  destroy(
    ref: SandboxRef,
    options: {signal: AbortSignal},
  ): Promise<void>;

  connect(ref: SandboxRef): SandboxClient;
}
```

`connect` is synchronous and process-local. It only constructs a client around
an existing ref. Every provider lifecycle operation and every client method is
called separately inside `restate.run` with that run's `AbortSignal`.

This boundary is important:

- Restate journals the result of every external operation;
- retries preserve the same logical operation;
- invocation cancellation supplies an `AbortSignal` to the provider;
- provider clients do not leak into durable state;
- `SandboxRef` is the only provider data serialized by Restate.

Providers should make lifecycle operations retry-safe. A retry may follow an
external success whose response was not yet durably recorded.

## Client contract

```ts
interface SandboxClient {
  listFiles(
    path: string,
    options: {signal: AbortSignal},
  ): Promise<string[]>;

  readFile(
    path: string,
    options: {signal: AbortSignal},
  ): Promise<string>;

  writeFile(
    path: string,
    content: string,
    options: {signal: AbortSignal},
  ): Promise<void>;

  executeCommand(
    command: {
      command: string;
      cwd?: string;
      timeoutMs?: number;
    },
    options: {signal: AbortSignal},
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}
```

Paths are relative to the sandbox workspace and must not escape it. Files are
UTF-8 in this reference implementation.

Commands are one-shot foreground operations. They return only after the
process exits or times out. They are not turn-pending operations because an
external sandbox process is not automatically durable across provider failure
or Restate recovery. If the user deliberately wants detached work, the model
must create and manage a background shell script explicitly.

## Local provider

The default implementation stores each Agent workspace under:

```text
/tmp/restate-agent-sandboxes/<encoded-agentId>
```

It creates directories lazily and enforces path containment. Suspend is a
logical state change only; resume recreates the directory if needed. Destroy
removes the directory recursively.

This is a development adapter, not a security boundary:

- commands run with the service process's identity and permissions;
- it does not isolate CPU, memory, network, or system calls;
- `/tmp` may not survive host replacement;
- a single service host sees only its own local filesystem.

Do not use the local provider for untrusted commands.

## Modal provider

Set:

```text
SANDBOX_PROVIDER=modal
MODAL_TOKEN_ID=<token-id>
MODAL_TOKEN_SECRET=<token-secret>
```

Optional settings:

```text
MODAL_APP_NAME=restate-agent-sandboxes
MODAL_SANDBOX_NAMESPACE=<stable-resource-namespace>
MODAL_SANDBOX_IMAGE=mcr.microsoft.com/devcontainers/universal:noble
MODAL_SANDBOX_TIMEOUT_MS=86400000
```

The provider uses:

- one deterministic named Modal Volume per Agent for persistent files;
- disposable Modal Sandbox compute mounted at `/workspace`;
- a deterministic sandbox name to recover an already-created resource after a
  Restate retry;
- termination on suspend while retaining the Volume;
- new compute mounted to the same Volume on resume;
- Volume deletion on destroy.

The ref contains the Volume name and a nullable live Sandbox ID:

```ts
{
  provider: "modal";
  sandboxId: string | null;
  volumeName: string;
}
```

Modal credentials are read by its SDK. Export shell variables before starting
the service; assigning an unexported shell variable does not place it in the
Node process environment.

The Modal JavaScript API does not currently expose termination of one
individual `Sandbox.exec` process. The adapter checks cancellation at operation
boundaries and continues awaiting an in-flight command, bounded by its command
timeout, rather than claiming it stopped while remote work continues.
Suspending or destroying the resource terminates the whole Modal Sandbox.

The resource name hashes a namespace and `agentId`. Keep the namespace stable
if the same logical Agents should reconnect to their existing Volumes.

## Provider selection and existing state

New sandboxes use `SANDBOX_PROVIDER`, defaulting to `local`. An existing
`SandboxRef` always selects the provider that created it, even if process
configuration later changes.

Changing `SANDBOX_PROVIDER` therefore does not migrate existing Agent
workspaces. Destroy the old resource or use a new `agentId` when intentionally
switching a test Agent between providers.

## Adding a provider

1. Add a new discriminant and serializable fields to `SandboxRefSchema`.
2. Implement `SandboxProvider` in its own adapter module.
3. Keep credentials and process-local SDK clients out of `SandboxRef`.
4. Make `provision`, `suspend`, `resume`, and `destroy` safe under retry.
5. Return updated refs when external identity changes.
6. Honor every `AbortSignal`.
7. Detach or close process-local SDK handles after each operation.
8. Enforce workspace path containment.
9. Add the provider to `configuredProvider()` for new refs and `providerFor()`
   for existing refs.
10. Exercise provision, repeated borrow, release/reborrow before timeout,
    suspend/resume, command cancellation, and destroy.

Do not put provider selection or lifecycle recovery into individual tools.
They should continue to depend only on `context.sandbox.client()`.

## Transcript policy

Sandbox provisioning and suspension are resource implementation details and
are not appended as special conversation events. Tool lifecycle entries still
show `listFiles`, `readFile`, `writeFile`, or `executeCommand` activity.
Provider calls and exact lifecycle operations remain visible in Restate's
invocation tree and journal.
