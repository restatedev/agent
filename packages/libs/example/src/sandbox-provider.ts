// Provider-neutral sandbox contracts plus the tiny local implementation used
// by this demo. Restate owns lifecycle orchestration in sandbox.ts.

import {exec} from "node:child_process";
import {mkdir, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {dirname, join, resolve, sep} from "node:path";
import {TerminalError} from "@restatedev/restate-sdk";

export type SandboxRef = {
  id: string;
};

export type SandboxOperationOptions = {
  signal: AbortSignal;
};

type SandboxProvisionOptions = SandboxOperationOptions & {
  agentId: string;
};

type SandboxConnectOptions = {
  turnId: string;
};

export type SandboxCommand = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
};

export type SandboxCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface SandboxClient {
  listFiles(path: string, options: SandboxOperationOptions): Promise<string[]>;
  readFile(path: string, options: SandboxOperationOptions): Promise<string>;
  writeFile(
    path: string,
    content: string,
    options: SandboxOperationOptions,
  ): Promise<void>;
  executeCommand(
    command: SandboxCommand,
    options: SandboxOperationOptions,
  ): Promise<SandboxCommandResult>;
}

export interface SandboxProvider {
  provision(options: SandboxProvisionOptions): Promise<SandboxRef>;
  suspend(ref: SandboxRef, options: SandboxOperationOptions): Promise<void>;
  resume(ref: SandboxRef, options: SandboxOperationOptions): Promise<void>;
  destroy(ref: SandboxRef, options: SandboxOperationOptions): Promise<void>;

  // Connecting is process-local and performs no external operation. Each
  // client method is invoked separately inside restate.run with its signal.
  connect(ref: SandboxRef, options: SandboxConnectOptions): SandboxClient;
}

const SANDBOX_ROOT = "/tmp/restate-agent-sandboxes";

function pathSegment(id: string): string {
  return encodeURIComponent(id).replaceAll(".", "%2E");
}

function containedPath(root: string, path: string): string {
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new TerminalError(`path escapes the sandbox: ${path}`);
  }
  return target;
}

function execute(
  command: SandboxCommand,
  cwd: string,
  signal: AbortSignal,
): Promise<SandboxCommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    exec(
      command.command,
      {
        cwd,
        signal,
        timeout: command.timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolveCommand({exitCode: 0, stdout, stderr});
          return;
        }
        if (signal.aborted || error.name === "AbortError") {
          rejectCommand(error);
          return;
        }
        resolveCommand({
          exitCode:
            typeof error.code === "number"
              ? error.code
              : error.killed
                ? 124
                : 1,
          stdout,
          stderr: stderr || error.message,
        });
      },
    );
  });
}

function localClient(root: string): SandboxClient {
  return {
    async listFiles(path, {signal}) {
      signal.throwIfAborted();
      await mkdir(root, {recursive: true});
      const entries = await readdir(containedPath(root, path), {
        withFileTypes: true,
      });
      return entries
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .sort();
    },

    async readFile(path, {signal}) {
      signal.throwIfAborted();
      return readFile(containedPath(root, path), {
        encoding: "utf8",
        signal,
      });
    },

    async writeFile(path, content, {signal}) {
      signal.throwIfAborted();
      const target = containedPath(root, path);
      await mkdir(dirname(target), {recursive: true});
      await writeFile(target, content, {encoding: "utf8", signal});
    },

    async executeCommand(command, {signal}) {
      signal.throwIfAborted();
      const cwd = containedPath(root, command.cwd ?? ".");
      await mkdir(cwd, {recursive: true});
      return execute(command, cwd, signal);
    },
  };
}

// This adapter is intentionally only a convenient local demo. Commands run as
// the service process, so the directory boundary is not a security sandbox.
export const sandboxProvider: SandboxProvider = {
  async provision({agentId, signal}) {
    signal.throwIfAborted();
    const root = join(SANDBOX_ROOT, pathSegment(agentId));
    await mkdir(root, {recursive: true});
    return {id: root};
  },

  async suspend(_ref, {signal}) {
    signal.throwIfAborted();
  },

  async resume(ref, {signal}) {
    signal.throwIfAborted();
    await mkdir(containedPath(SANDBOX_ROOT, ref.id), {recursive: true});
  },

  async destroy(ref, {signal}) {
    signal.throwIfAborted();
    await rm(containedPath(SANDBOX_ROOT, ref.id), {
      recursive: true,
      force: true,
    });
  },

  connect(ref, {turnId}) {
    const agentRoot = containedPath(SANDBOX_ROOT, ref.id);
    return localClient(join(agentRoot, pathSegment(turnId)));
  },
};
