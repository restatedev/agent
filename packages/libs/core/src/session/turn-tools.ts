// The permitted tool catalog for one turn: granted built-ins, annotated
// Restate handlers and configured MCP servers. Discovery is journaled, so
// inference and execution use the same snapshot on replay.

import {createHash} from "node:crypto";

import type {Message} from "@restate-agents/core";
import {mcpTools} from "@restate-agents/core/mcp";
import {
  type AgentTurnRequest,
  type McpServer,
  toolSelected,
} from "@restate-agents/types";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

import {mcpAvailabilityMessage} from "./context.js";
import {resolveMcpToken} from "./mcp-config.js";
import {discoverRestateTools} from "./restate-tools.js";
import {builtins, programsEnabled} from "./tools.js";
import type {TurnContext, TurnTool} from "./turn-context.js";

export type McpServerAvailability =
  | {serverId: string; status: "available"; toolCount: number}
  | {serverId: string; status: "unavailable"; warnings: string[]};

type TurnTools = {
  tools: Record<string, TurnTool>;
  /** Runtime status the model should know, such as unavailable servers. */
  notes: Message[];
  close(): restate.Operation<void>;
};

const MCP_NAMESPACE = /^[a-zA-Z0-9_-]{1,24}$/;

/** MCP namespaces are short identifiers; other server IDs get a stable hash. */
function namespace(server: McpServer): string {
  if (MCP_NAMESPACE.test(server.id)) return server.id;
  const prefix = server.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 15);
  const hash = createHash("sha256").update(server.id).digest("hex").slice(0, 8);
  return `${prefix}_${hash}`;
}

export function* turnTools({
  tools: grants,
  webSearchEnabled,
  mcpServers,
}: AgentTurnRequest): restate.Operation<TurnTools> {
  const tools: Record<string, TurnTool> = {};
  // Earlier sources win: built-ins, then Restate handlers, then MCP servers.
  const add = (name: string, tool: TurnTool, source: string) => {
    if (Object.hasOwn(tools, name))
      restate
        .logger()
        .warn(`Ignored ${source} tool ${name}: the name is taken`);
    else tools[name] = tool;
  };

  // Journaled, so an in-flight turn replays with the setting it started with.
  const programs = yield* restate.run(async () => programsEnabled(), {
    name: "program-tool-enabled",
  });
  for (const [name, tool] of Object.entries(builtins)) {
    if (!toolSelected(grants.builtin, name)) continue;
    if (name === "webSearch" && !webSearchEnabled) continue;
    if (name === "executeProgram" && !programs) continue;
    add(name, tool, "built-in");
  }

  const dynamic = grants.dynamic;
  if (dynamic.mode === "all" || dynamic.names.length > 0) {
    const discovered = yield* discoverRestateTools((id) =>
      toolSelected(dynamic, id),
    );
    for (const [name, {tool}] of Object.entries(discovered))
      add(name, tool, "Restate");
  }

  const closers: Array<() => restate.Operation<void>> = [];
  const availability: McpServerAvailability[] = [];
  for (const server of mcpServers) {
    const grant = grants.mcp.find(({serverId}) => serverId === server.id);
    if (!grant) continue;
    try {
      const set = yield* mcpTools<TurnContext>({
        url: server.url,
        namespace: namespace(server),
        protocol: server.protocol,
        // One attempt per call: a repeated call can repeat its side effects.
        retry: {maxAttempts: 1},
        *token() {
          return resolveMcpToken(server);
        },
        allow: (remoteName) => toolSelected(grant.tools, remoteName),
      });
      for (const warning of set.warnings) restate.logger().warn(warning);
      for (const [name, tool] of Object.entries(set.tools))
        add(name, tool, `MCP ${server.id}`);
      closers.push(set.close);
      availability.push({
        serverId: server.id,
        status: "available",
        toolCount: Object.keys(set.tools).length,
      });
    } catch (error) {
      if (!(error instanceof TerminalError)) throw error;
      availability.push({
        serverId: server.id,
        status: "unavailable",
        warnings: [error.message],
      });
    }
  }

  return {
    tools,
    notes:
      availability.length > 0 ? [mcpAvailabilityMessage(availability)] : [],
    *close() {
      for (const close of closers) yield* close();
    },
  };
}
