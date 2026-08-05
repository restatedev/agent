// Provider-neutral sandbox contracts and provider selection. Restate owns
// lifecycle orchestration in service.ts; concrete adapters live beside this
// module.

import {TerminalError} from "@restatedev/restate-sdk";
import {z} from "zod";
import {localSandboxProvider} from "./local-provider.js";
import {modalSandboxProvider} from "./modal-provider.js";

export const SandboxRefSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("local"),
    root: z.string(),
  }),
  z.object({
    provider: z.literal("modal"),
    sandboxId: z.string().nullable(),
    volumeName: z.string(),
  }),
]);

export type SandboxRef = z.infer<typeof SandboxRefSchema>;

export type SandboxOperationOptions = {
  signal: AbortSignal;
};

type SandboxProvisionOptions = SandboxOperationOptions & {
  agentId: string;
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
  suspend(
    ref: SandboxRef,
    options: SandboxOperationOptions,
  ): Promise<SandboxRef>;
  resume(
    ref: SandboxRef,
    options: SandboxOperationOptions,
  ): Promise<SandboxRef>;
  destroy(ref: SandboxRef, options: SandboxOperationOptions): Promise<void>;

  // Connecting is process-local and performs no external operation. Each
  // client method is invoked separately inside restate.run with its signal.
  connect(ref: SandboxRef): SandboxClient;
}

function configuredProvider(): SandboxProvider {
  const name = process.env.SANDBOX_PROVIDER?.trim().toLowerCase() || "local";
  switch (name) {
    case "local":
      return localSandboxProvider;
    case "modal":
      return modalSandboxProvider;
    default:
      throw new TerminalError(
        `unknown SANDBOX_PROVIDER ${JSON.stringify(name)}; expected local or modal`,
      );
  }
}

function providerFor(ref: SandboxRef): SandboxProvider {
  return ref.provider === "modal" ? modalSandboxProvider : localSandboxProvider;
}

// New sandboxes use the configured provider. Existing references continue to
// use the provider that created them, even if process configuration changes.
export const sandboxProvider: SandboxProvider = {
  provision(options) {
    return configuredProvider().provision(options);
  },

  suspend(ref, options) {
    return providerFor(ref).suspend(ref, options);
  },

  resume(ref, options) {
    return providerFor(ref).resume(ref, options);
  },

  destroy(ref, options) {
    return providerFor(ref).destroy(ref, options);
  },

  connect(ref) {
    return providerFor(ref).connect(ref);
  },
};
