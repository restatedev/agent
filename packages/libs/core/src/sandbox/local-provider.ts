// Zero-configuration local sandbox adapter. Commands run as the service
// process, so the directory boundary is convenient for demos but is not a
// security sandbox.

import {exec} from "node:child_process";
import {mkdir, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {dirname, join, resolve, sep} from "node:path";

import {TerminalError} from "@restatedev/restate-sdk";

import type {SandboxProvider, SandboxRef} from "./provider.js";

const SANDBOX_ROOT = "/tmp/restate-agent-sandboxes";

/** Demo-only sandbox provider backed by one local `/tmp` directory per Agent. */
export const localSandboxProvider: SandboxProvider = {
  async provision({agentId, signal}) {
    signal.throwIfAborted();
    const root = join(
      SANDBOX_ROOT,
      encodeURIComponent(agentId).replaceAll(".", "%2E"),
    );
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
    const root = containedPath(SANDBOX_ROOT, localRef(ref).root);
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
        return new Promise((resolveCommand, rejectCommand) => {
          exec(
            command.command,
            {
              cwd,
              env: commandEnv(root),
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
      },
    };
  },
};

/**
 * The environment of a model-issued command. `exec` would otherwise inherit
 * the whole service environment, and a model running `env` would read
 * model API keys, MCP tokens, RESTATE_ADMIN_TOKEN and Modal credentials into
 * its context (and the journal). Only what ordinary shell tools need is
 * passed; HOME points into the workspace so dotfiles land there too. This
 * narrows accidental disclosure only: the command still runs as the service
 * user and can read the same files (see the module note).
 */
function commandEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: root,
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
  };
}

function localRef(ref: SandboxRef): Extract<SandboxRef, {provider: "local"}> {
  if (ref.provider !== "local") {
    throw new TerminalError(`expected a local sandbox, got ${ref.provider}`);
  }
  return ref;
}

function containedPath(root: string, path: string): string {
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new TerminalError(`path escapes the sandbox: ${path}`);
  }
  return target;
}
