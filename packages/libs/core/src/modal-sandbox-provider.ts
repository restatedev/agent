import {createHash} from "node:crypto";
import {posix} from "node:path";
import {TerminalError} from "@restatedev/restate-sdk";
import {
  AlreadyExistsError,
  ModalClient,
  NotFoundError,
  type Sandbox,
} from "modal";
import type {
  SandboxClient,
  SandboxCommand,
  SandboxCommandResult,
  SandboxOperationOptions,
  SandboxProvider,
  SandboxRef,
} from "./sandbox-provider.js";

const WORKDIR = "/workspace";
const DEFAULT_APP = "restate-agent-sandboxes";
const DEFAULT_IMAGE = "debian:bookworm-slim";
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

type ModalRef = Extract<SandboxRef, {provider: "modal"}>;

let client: ModalClient | undefined;

function modal(): ModalClient {
  client ??= new ModalClient();
  return client;
}

function modalRef(ref: SandboxRef): ModalRef {
  if (ref.provider !== "modal") {
    throw new TerminalError(`expected a Modal sandbox, got ${ref.provider}`);
  }
  return ref;
}

function requiredSandboxId(ref: ModalRef): string {
  if (!ref.sandboxId) {
    throw new TerminalError("Modal sandbox is suspended");
  }
  return ref.sandboxId;
}

function configuredTimeout(): number {
  const raw = process.env.MODAL_SANDBOX_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_TIMEOUT_MS;
  }
  const timeout = Number(raw);
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > DEFAULT_TIMEOUT_MS
  ) {
    throw new TerminalError(
      `MODAL_SANDBOX_TIMEOUT_MS must be an integer between 1 and ${DEFAULT_TIMEOUT_MS}, got ${JSON.stringify(raw)}`,
    );
  }
  return timeout;
}

function resourceName(agentId: string): string {
  const namespace =
    process.env.MODAL_SANDBOX_NAMESPACE ||
    process.env.MODAL_APP_NAME ||
    DEFAULT_APP;
  const digest = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(agentId)
    .digest("hex")
    .slice(0, 32);
  return `restate-agent-${digest}`;
}

function remotePath(path: string): string {
  const target = posix.resolve(WORKDIR, path);
  if (target !== WORKDIR && !target.startsWith(`${WORKDIR}/`)) {
    throw new TerminalError(`path escapes the sandbox: ${path}`);
  }
  return target;
}

async function createSandbox(volumeName: string): Promise<Sandbox> {
  const sdk = modal();
  const appName = process.env.MODAL_APP_NAME || DEFAULT_APP;
  const timeoutMs = configuredTimeout();
  const app = await sdk.apps.fromName(appName, {createIfMissing: true});
  const volume = await sdk.volumes.fromName(volumeName, {
    createIfMissing: true,
  });
  const image = sdk.images.fromRegistry(
    process.env.MODAL_SANDBOX_IMAGE || DEFAULT_IMAGE,
  );

  try {
    return await sdk.sandboxes.create(app, image, {
      name: volumeName,
      timeoutMs,
      workdir: WORKDIR,
      volumes: {[WORKDIR]: volume},
      tags: {
        "managed-by": "restate-agent-reference",
      },
    });
  } catch (error) {
    // Restate may retry after Modal created the named sandbox but before its
    // response became durable. Recover that sandbox instead of creating
    // another one.
    if (error instanceof AlreadyExistsError) {
      return sdk.sandboxes.fromName(appName, volumeName);
    }
    throw error;
  }
}

async function attachedSandbox(
  ref: ModalRef,
  signal: AbortSignal,
): Promise<Sandbox> {
  signal.throwIfAborted();
  return modal().sandboxes.fromId(requiredSandboxId(ref));
}

async function withSandbox<T>(
  ref: ModalRef,
  {signal}: SandboxOperationOptions,
  operation: (sandbox: Sandbox) => Promise<T>,
): Promise<T> {
  const sandbox = await attachedSandbox(ref, signal);
  try {
    const result = await operation(sandbox);
    signal.throwIfAborted();
    return result;
  } finally {
    sandbox.detach();
  }
}

async function terminate(ref: ModalRef, signal: AbortSignal): Promise<void> {
  if (!ref.sandboxId) {
    return;
  }
  try {
    signal.throwIfAborted();
    const sandbox = await modal().sandboxes.fromId(ref.sandboxId);
    await sandbox.terminate({wait: true});
    signal.throwIfAborted();
  } catch (error) {
    // A retry after a successful termination sees no running sandbox.
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
}

function modalClient(ref: ModalRef): SandboxClient {
  return {
    async listFiles(path, options) {
      return withSandbox(ref, options, async (sandbox) => {
        const entries = await sandbox.filesystem.listFiles(remotePath(path));
        return entries.map(
          (entry) => `${entry.name}${entry.type === "directory" ? "/" : ""}`,
        );
      });
    },

    async readFile(path, options) {
      return withSandbox(ref, options, (sandbox) =>
        sandbox.filesystem.readText(remotePath(path)),
      );
    },

    async writeFile(path, content, options) {
      await withSandbox(ref, options, (sandbox) =>
        sandbox.filesystem.writeText(content, remotePath(path)),
      );
    },

    async executeCommand(
      command: SandboxCommand,
      options: SandboxOperationOptions,
    ): Promise<SandboxCommandResult> {
      return withSandbox(ref, options, async (sandbox) => {
        const process = await sandbox.exec(["sh", "-lc", command.command], {
          timeoutMs: command.timeoutMs,
          workdir: remotePath(command.cwd ?? "."),
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          process.stdout.readText(),
          process.stderr.readText(),
          process.wait(),
        ]);
        return {exitCode, stdout, stderr};
      });
    },
  };
}

/**
 * Modal-backed implementation of the provider contract. A named Volume owns
 * each Agent's persistent files; the Sandbox itself is disposable compute.
 */
export const modalSandboxProvider: SandboxProvider = {
  async provision({agentId, signal}) {
    signal.throwIfAborted();
    const volumeName = resourceName(agentId);
    const sandbox = await createSandbox(volumeName);
    const ref: ModalRef = {
      provider: "modal",
      sandboxId: sandbox.sandboxId,
      volumeName,
    };
    sandbox.detach();
    signal.throwIfAborted();
    return ref;
  },

  async suspend(ref, {signal}) {
    const current = modalRef(ref);
    await terminate(current, signal);
    return {...current, sandboxId: null};
  },

  async resume(ref, {signal}) {
    const current = modalRef(ref);
    if (current.sandboxId) {
      return current;
    }
    signal.throwIfAborted();
    const sandbox = await createSandbox(current.volumeName);
    const resumed = {...current, sandboxId: sandbox.sandboxId};
    sandbox.detach();
    signal.throwIfAborted();
    return resumed;
  },

  async destroy(ref, {signal}) {
    const current = modalRef(ref);
    await terminate(current, signal);
    signal.throwIfAborted();
    await modal().volumes.delete(current.volumeName, {allowMissing: true});
    signal.throwIfAborted();
  },

  connect(ref) {
    return modalClient(modalRef(ref));
  },
};
