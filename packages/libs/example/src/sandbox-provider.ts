// Provider-neutral sandbox contracts. Restate owns lifecycle orchestration in
// sandbox.ts; a provider owns the external resource and its one-shot I/O.

import {TerminalError} from "@restatedev/restate-sdk";

export type SandboxRef = {
  id: string;
};

export type SandboxOperationOptions = {
  signal: AbortSignal;
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
  provision(options: SandboxOperationOptions): Promise<SandboxRef>;
  suspend(ref: SandboxRef, options: SandboxOperationOptions): Promise<void>;
  resume(ref: SandboxRef, options: SandboxOperationOptions): Promise<void>;
  destroy(ref: SandboxRef, options: SandboxOperationOptions): Promise<void>;

  // Connecting is process-local and performs no external operation. Each
  // client method is invoked separately inside restate.run with its signal.
  connect(ref: SandboxRef): SandboxClient;
}

function unavailable(signal: AbortSignal): never {
  signal.throwIfAborted();
  throw new TerminalError("No sandbox provider is configured");
}

const noopClient: SandboxClient = {
  async listFiles(_path, {signal}) {
    return unavailable(signal);
  },

  async readFile(_path, {signal}) {
    return unavailable(signal);
  },

  async writeFile(_path, _content, {signal}) {
    return unavailable(signal);
  },

  async executeCommand(_command, {signal}) {
    return unavailable(signal);
  },
};

// The reference keeps the provider seam executable without choosing a vendor.
// Replacing this object is sufficient to connect a real sandbox implementation.
export const sandboxProvider: SandboxProvider = {
  async provision({signal}) {
    signal.throwIfAborted();
    return {id: "noop"};
  },

  async suspend(_ref, {signal}) {
    signal.throwIfAborted();
  },

  async resume(_ref, {signal}) {
    signal.throwIfAborted();
  },

  async destroy(_ref, {signal}) {
    signal.throwIfAborted();
  },

  connect(_ref) {
    return noopClient;
  },
};
