// Operator configuration is snapshotted once per turn. Only references, never
// credential values, cross a durable interface.
import {
  type AgentTools,
  type McpServer,
  McpServerSchema,
} from "@restate-agents/types";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";

const Config = z.array(McpServerSchema.strict()).max(32);

export class McpConfigurationError extends Error {}

export function readMcpConfiguration(env = process.env): McpServer[] {
  try {
    const servers = Config.parse(JSON.parse(env.MCP_SERVERS_JSON ?? "[]"));
    if (new Set(servers.map((server) => server.id)).size !== servers.length)
      throw new Error();
    for (const server of servers) {
      const url = new URL(server.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
    }
    return servers;
  } catch {
    // Parsing errors can contain the supplied configuration. Never journal it.
    throw new McpConfigurationError(
      "Invalid MCP_SERVERS_JSON: use unique HTTP server IDs, protocol, URL, and optional tokenEnv; never inline credentials",
    );
  }
}

export function* configuredMcpServers(): restate.Operation<McpServer[]> {
  return yield* restate.run(
    async () => {
      try {
        return readMcpConfiguration();
      } catch {
        throw new TerminalError("Invalid MCP_SERVERS_JSON configuration");
      }
    },
    {name: "mcp-configuration"},
  );
}

export function resolveMcpGrants(
  tools: AgentTools,
  servers: McpServer[],
): AgentTools {
  return {
    ...tools,
    mcp: servers.flatMap((server) => {
      const grant = tools.mcp.find((item) => item.connectionId === server.id);
      return grant
        ? [grant]
        : tools.mcpDefault === "disabled"
          ? []
          : [{connectionId: server.id, tools: {mode: "all" as const}}];
    }),
  };
}

/** Call only inside the HTTP effect; do not return the value from a run. */
export function resolveMcpToken(
  server: McpServer,
  env = process.env,
): string | undefined {
  const configured = readMcpConfiguration(env).find(
    (item) => item.id === server.id,
  );
  if (
    !configured ||
    configured.url !== server.url ||
    configured.protocol !== server.protocol ||
    configured.tokenEnv !== server.tokenEnv
  )
    throw new McpConfigurationError(
      "MCP configuration changed; start a new turn",
    );
  if (!configured.tokenEnv) return undefined;
  const token = env[configured.tokenEnv]?.trim();
  if (!token)
    throw new McpConfigurationError(
      "MCP credential environment variable is missing",
    );
  return token;
}
