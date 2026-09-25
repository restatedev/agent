// Tools that act in the agent's persistent sandbox. The turn provisions or
// resumes the sandbox on first use and suspends it when the turn ends.

import {tool} from "@restate-agents/core";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";

import type {SandboxClient} from "../../sandbox/index.js";
import type {TurnTool} from "../turn-context.js";

// Reads, listings and whole-file writes are safe to repeat. The bound keeps a
// dead or unreachable sandbox from retrying for the rest of the turn.
const IDEMPOTENT_RETRY: restate.RetryOptions = {
  maxAttempts: 3,
  initialInterval: 500,
  maxInterval: 2_000,
  exponentiationFactor: 2,
};

/** One journaled operation on the turn's lazily acquired sandbox. */
function sandboxTool<Schema extends z.ZodType>(definition: {
  description: string;
  input: Schema;
  /** Fixed transcript label: raw arguments never enter the public history. */
  summary: string;
  retry: restate.RetryOptions;
  run(
    input: z.output<Schema>,
    client: SandboxClient,
    signal: AbortSignal,
  ): Promise<string>;
}): TurnTool {
  return tool({
    description: definition.description,
    input: definition.input,
    describe: {name: definition.summary},
    *execute(input, {context, toolName}) {
      const client = yield* context.sandbox.client();
      return yield* restate.run(
        ({signal}) => definition.run(input, client, signal),
        {
          name: toolName,
          retry: definition.retry,
        },
      );
    },
  });
}

// A file or command output is clipped inside the run, before it is journaled,
// so one `cat` of a large log cannot bloat the journal. Matches the local
// provider's 1 MiB exec buffer.
const MAX_SOURCE_CHARS = 1_000_000;

function clipped(text: string, what: string): string {
  if (text.length <= MAX_SOURCE_CHARS) return text;
  const omitted = text.length - MAX_SOURCE_CHARS;
  return `${text.slice(0, MAX_SOURCE_CHARS)}\n[${what} clipped: ${omitted} more characters omitted]`;
}

export const listFiles = sandboxTool({
  description:
    "List files at one path in the agent's persistent sandbox. Use '.' for the working directory.",
  input: z.object({
    path: z.string().min(1).describe("Directory path to list."),
  }),
  summary: "Listed files",
  retry: IDEMPOTENT_RETRY,
  run: async ({path}, client, signal) =>
    JSON.stringify(await client.listFiles(path, {signal})),
});

export const readFile = sandboxTool({
  description: "Read one UTF-8 text file from the agent's persistent sandbox.",
  input: z.object({
    path: z.string().min(1).describe("Path of the text file to read."),
  }),
  summary: "Read a file",
  retry: IDEMPOTENT_RETRY,
  run: async ({path}, client, signal) =>
    clipped(await client.readFile(path, {signal}), "file"),
});

export const writeFile = sandboxTool({
  description:
    "Write one complete UTF-8 text file in the agent's persistent sandbox, replacing its previous contents.",
  input: z.object({
    path: z.string().min(1).describe("Path of the text file to write."),
    content: z.string().describe("Complete new contents of the file."),
  }),
  summary: "Wrote a file",
  // Writing the complete contents again converges on the same file.
  retry: IDEMPOTENT_RETRY,
  async run({path, content}, client, signal) {
    await client.writeFile(path, content, {signal});
    return `Wrote ${Buffer.byteLength(content)} bytes to ${path}`;
  },
});

export const executeCommand = sandboxTool({
  description:
    "Execute one shell command in the agent's persistent sandbox and wait for its final exit result. This tool never becomes a pending agent operation. To intentionally leave work running, launch and track a background shell script from the command itself.",
  input: z.object({
    command: z.string().min(1).describe("Shell command to execute."),
    cwd: z
      .string()
      .min(1)
      .nullable()
      .describe("Working directory, or null for the sandbox default."),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(3_600)
      .nullable()
      .describe(
        "Command timeout in seconds, or null for the provider default.",
      ),
  }),
  summary: "Ran command",
  // A shell command is not idempotent, and a transport error can arrive after
  // it already ran remotely. Report the failure to the model, which can
  // inspect the workspace, instead of silently running it again. (Crash
  // recovery can still repeat an unjournaled command.)
  retry: {maxAttempts: 1},
  async run({command, cwd, timeoutSeconds}, client, signal) {
    const result = await client.executeCommand(
      {
        command,
        cwd: cwd ?? undefined,
        timeoutMs: timeoutSeconds === null ? undefined : timeoutSeconds * 1_000,
      },
      {signal},
    );
    return JSON.stringify({
      ...result,
      stdout: clipped(result.stdout, "stdout"),
      stderr: clipped(result.stderr, "stderr"),
    });
  },
});
