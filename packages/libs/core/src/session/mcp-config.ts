// Operator configuration is snapshotted once per turn. Only references, never
// credential values, cross a durable interface.
import {
  type AgentTools,
  type McpServer,
  mcpServerGranted,
  McpServerSchema,
} from "@restate-agents/types";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";

const Config = z.array(McpServerSchema.strict()).max(32);

/** Terminal: a server with bad configuration is unavailable for the turn, and
 * a call made under a stale snapshot fails without retrying. */
export class McpConfigurationError extends TerminalError {}

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
      "Invalid MCP_SERVERS_JSON: use unique HTTP server IDs, protocol, URL, and optional tokenEnv naming a *_MCP_TOKEN variable; never inline credentials",
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
      const grant = tools.mcp.find((item) => item.serverId === server.id);
      return grant
        ? [grant]
        : tools.mcpDefault === "disabled"
          ? []
          : [{serverId: server.id, tools: {mode: "all" as const}}];
    }),
  };
}

/** The servers a turn may connect to: granted with at least one tool. */
export function grantedMcpServers(
  tools: AgentTools,
  servers: McpServer[],
): McpServer[] {
  return servers.filter((server) => mcpServerGranted(tools, server.id));
}

/**
 * The operator's token for a server. Called in handler code through the SDK's
 * `token` callback, right before each HTTP call; the value is used only inside
 * that call's effect and is never returned from a journaled run.
 */
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
