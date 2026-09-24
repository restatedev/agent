// Tools that act in the agent's persistent sandbox. The turn provisions or
// resumes the sandbox on first use and suspends it when the turn ends.

import type * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";

import type {SandboxClient} from "../../sandbox/index.js";
import {
  defineAgentTool,
  type ToolCallContext,
  type ToolExecution,
  toolFailure,
  toolRun,
} from "./define.js";

export const listFilesTool = defineAgentTool({
  name: "listFiles",
  description:
    "List files at one path in the agent's persistent sandbox. Use '.' for the working directory.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Directory path to list."),
  }),
  summarize: ({path}) => `Listed files in ${path}`,
  *run({path}, context) {
    return yield* runSandboxTool(
      `Listed files in ${path}`,
      context,
      async (client, signal) =>
        JSON.stringify(await client.listFiles(path, {signal})),
      IDEMPOTENT_RETRY,
    );
  },
});

export const readFileTool = defineAgentTool({
  name: "readFile",
  description: "Read one UTF-8 text file from the agent's persistent sandbox.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Path of the text file to read."),
  }),
  summarize: ({path}) => `Read ${path}`,
  *run({path}, context) {
    return yield* runSandboxTool(
      `Read ${path}`,
      context,
      async (client, signal) => client.readFile(path, {signal}),
      IDEMPOTENT_RETRY,
    );
  },
});

export const writeFileTool = defineAgentTool({
  name: "writeFile",
  description:
    "Write one complete UTF-8 text file in the agent's persistent sandbox, replacing its previous contents.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Path of the text file to write."),
    content: z.string().describe("Complete new contents of the file."),
  }),
  summarize: ({path}) => `Wrote ${path}`,
  *run({path, content}, context) {
    return yield* runSandboxTool(
      `Wrote ${path}`,
      context,
      async (client, signal) => {
        await client.writeFile(path, content, {signal});
        return `Wrote ${Buffer.byteLength(content)} bytes to ${path}`;
      },
      // Writing the complete contents again converges on the same file.
      IDEMPOTENT_RETRY,
    );
  },
});

export const executeCommandTool = defineAgentTool({
  name: "executeCommand",
  description:
    "Execute one shell command in the agent's persistent sandbox and wait for its final exit result. This tool never becomes a pending agent operation. To intentionally leave work running, launch and track a background shell script from the command itself.",
  inputSchema: z.object({
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
  summarize: () => "Ran command",
  *run({command, cwd, timeoutSeconds}, context) {
    return yield* runSandboxTool(
      "Ran command",
      context,
      async (client, signal) => {
        const result = await client.executeCommand(
          {
            command,
            cwd: cwd ?? undefined,
            timeoutMs:
              timeoutSeconds === null ? undefined : timeoutSeconds * 1_000,
          },
          {signal},
        );
        return JSON.stringify(result);
      },
      // A shell command is not idempotent, and a transport error can arrive
      // after it already ran remotely. Report the failure to the model, which
      // can inspect the workspace, instead of silently running it again.
      // (Crash recovery can still repeat an unjournaled command.)
      {maxAttempts: 1},
    );
  },
});

// Reads, listings and whole-file writes are safe to repeat. The bound keeps a
// dead or unreachable sandbox from retrying for the rest of the turn.
const IDEMPOTENT_RETRY: restate.RetryOptions = {
  maxAttempts: 3,
  initialInterval: 500,
  maxInterval: 2_000,
  exponentiationFactor: 2,
};

function* runSandboxTool(
  name: string,
  context: ToolCallContext,
  operation: (client: SandboxClient, signal: AbortSignal) => Promise<string>,
  retry: restate.RetryOptions,
): restate.Operation<ToolExecution> {
  let client: SandboxClient;
  try {
    client = yield* context.sandbox.client();
  } catch (error) {
    return toolFailure(name, error);
  }
  return yield* toolRun(name, ({signal}) => operation(client, signal), retry);
}
