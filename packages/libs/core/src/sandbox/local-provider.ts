// Zero-configuration local sandbox adapter. Commands run as the service
// process, so the directory boundary is convenient for demos but is not a
// security sandbox.

import {exec} from "node:child_process";
import {mkdir, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {dirname, join, resolve, sep} from "node:path";
import {TerminalError} from "@restatedev/restate-sdk";
import type {
  SandboxClient,
  SandboxCommand,
  SandboxCommandResult,
  SandboxProvider,
  SandboxRef,
} from "./provider.js";

const SANDBOX_ROOT = "/tmp/restate-agent-sandboxes";

function localRef(ref: SandboxRef): Extract<SandboxRef, {provider: "local"}> {
  if (ref.provider !== "local") {
    throw new TerminalError(`expected a local sandbox, got ${ref.provider}`);
  }
  return ref;
}

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

export const localSandboxProvider: SandboxProvider = {
  async provision({agentId, signal}) {
    signal.throwIfAborted();
    const root = join(SANDBOX_ROOT, pathSegment(agentId));
    await mkdir(root, {recursive: true});
    return {provider: "local", root};
  },

  async suspend(ref, {signal}) {
    signal.throwIfAborted();
    return localRef(ref);
  },

  async resume(ref, {signal}) {
    signal.throwIfAborted();
    const local = localRef(ref);
    await mkdir(containedPath(SANDBOX_ROOT, local.root), {recursive: true});
    return local;
  },

  async destroy(ref, {signal}) {
    signal.throwIfAborted();
    await rm(containedPath(SANDBOX_ROOT, localRef(ref).root), {
      recursive: true,
      force: true,
    });
  },

  connect(ref) {
    return localClient(containedPath(SANDBOX_ROOT, localRef(ref).root));
  },
};
