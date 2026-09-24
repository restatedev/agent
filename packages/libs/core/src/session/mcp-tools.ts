// MCP tool discovery and invocation. Operator-configured servers explicitly select
// stateless 2026-07-28 discovery or the stateful 2025-era initialize protocol.
// Operator-configured credential references are resolved only inside HTTP
// effects. Each Turn journals the selected catalog and protocol verdict,
// then calls the exact snapshotted remote tool definition.

import {createHash} from "node:crypto";
import {setTimeout as sleep} from "node:timers/promises";

import {
  type CallToolResult,
  Client,
  type DiscoverResult,
  InsufficientScopeError,
  type PriorDiscovery,
  StreamableHTTPClientTransport,
  type Tool,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type {McpServer} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";

import {isCancellation} from "../errors.js";
import {abortable, createRefreshingCache} from "../refresh-cache.js";
import {McpConfigurationError, resolveMcpToken} from "./mcp-config.js";

const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_CLIENT = {name: "restate-agent-reference", version: "0.0.1"};
const MAX_MODEL_TOOL_NAME = 64;
const MAX_TOOLS_PER_SERVER = 128;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_INPUT_SCHEMA_CHARS = 64_000;
const MAX_RESULT_CHARS = 128_000;
const MAX_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_CACHED_CATALOGS = 256;
const REFRESH_RETRY_INTERVAL_MS = 30 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1_000;
const DISCOVERY_ATTEMPTS = 3;
const DISCOVERY_BACKOFF_MS = 250;

type McpServerSnapshot = McpServer & {turnId: string; timeoutMs: number};

type McpConnection = {
  client: Client;
};

type StatefulConnection = {
  turnId: string;
  connection: Promise<McpConnection>;
};

type McpServerCatalog = {
  server: McpServerSnapshot;
  prior: PriorDiscovery;
  tools: Tool[];
};

type McpCatalogDefinition = Omit<McpServerCatalog, "server">;

type McpDiscoveryResult = {
  catalog?: McpServerCatalog;
  warnings: string[];
};

type McpCachedDiscoveryResult = {
  catalog?: McpCatalogDefinition;
  warnings: string[];
};

/** A model-facing alias and its exact snapshotted MCP invocation target. */
export type McpAgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  target: {
    server: McpServerSnapshot;
    remoteName: string;
    definition: Tool;
    prior: PriorDiscovery;
  };
};

type McpToolExecution =
  | {status: "succeeded"; result: string}
  | {status: "failed"; error: string};

export type McpServerAvailability = {
  serverId: string;
  status: "available" | "unavailable";
  toolCount: number;
  warnings: string[];
};

type McpToolDiscovery = {
  tools: McpAgentTool[];
  servers: McpServerAvailability[];
};

const catalogs = createRefreshingCache<McpCatalogDefinition>({
  retryAfterMs: REFRESH_RETRY_INTERVAL_MS,
  maxEntries: MAX_CACHED_CATALOGS,
});
const statefulConnections = new Map<string, StatefulConnection>();

/**
 * Discovers tools from every configured MCP server using its declared era.
 *
 * Configuration and each server result pass through Restate runs, so a replay
 * observes the same endpoint set and tool catalog. Independent server reads run
 * concurrently and fail independently.
 */
export function* discoverMcpTools(
  servers: McpServer[],
  context: {agentId: string; turnId: string},
  reservedNames: string[],
): restate.Operation<McpToolDiscovery> {
  if (servers.length === 0) {
    return {tools: [], servers: []};
  }

  const tasks = servers.map((server) =>
    restate.spawn(discoverMcpServer(server, context)),
  );
  const results = yield* restate.all(tasks);
  for (const warning of results.flatMap(({warnings}) => warnings)) {
    restate.logger().warn(`MCP tool discovery: ${warning}`);
  }

  const reserved = new Set(reservedNames);
  const tools: McpAgentTool[] = [];
  const catalogs = results
    .flatMap(({catalog}) => (catalog ? [catalog] : []))
    .sort((left, right) => left.server.id.localeCompare(right.server.id));

  for (const catalog of catalogs) {
    const remoteNames = new Set<string>();
    const remoteTools = [...catalog.tools].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const tool of remoteTools) {
      if (remoteNames.has(tool.name)) {
        restate
          .logger()
          .warn(
            `MCP tool discovery: ignored duplicate ${catalog.server.id}/${tool.name}`,
          );
        continue;
      }
      remoteNames.add(tool.name);

      const schemaSize = JSON.stringify(tool.inputSchema).length;
      if (schemaSize > MAX_INPUT_SCHEMA_CHARS) {
        restate
          .logger()
          .warn(
            `MCP tool discovery: ignored ${catalog.server.id}/${tool.name}: input schema exceeds ${MAX_INPUT_SCHEMA_CHARS} characters`,
          );
        continue;
      }

      const name = uniqueModelName(catalog.server.id, tool.name, reserved);
      reserved.add(name);
      tools.push({
        name,
        description: modelDescription(catalog.server.id, tool),
        inputSchema: tool.inputSchema as Record<string, unknown>,
        target: {
          server: catalog.server,
          remoteName: tool.name,
          definition: tool,
          prior: catalog.prior,
        },
      });
    }
  }
  return {
    tools,
    servers: results.map((result, index) => ({
      serverId: servers[index].id,
      status: result.catalog ? "available" : "unavailable",
      toolCount: result.catalog?.tools.length ?? 0,
      warnings: result.warnings,
    })),
  };
}

/** Invokes one snapshotted tool through its configured MCP protocol mode. */
export function* executeMcpTool(
  input: Record<string, unknown>,
  context: {turnId: string; toolCallId: string},
  tool: McpAgentTool,
): restate.Operation<McpToolExecution> {
  try {
    const attempt = yield* callMcpTool(input, context, tool);
    if (attempt.status === "failed") return attempt;
    const result = attempt.value;
    const rendered = renderToolResult(result);
    return result.isError
      ? {status: "failed", error: rendered}
      : {status: "succeeded", result: rendered};
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    return {
      status: "failed",
      error: `${tool.name} failed: ${sanitizedMessage(error)}`,
    };
  }
}

function* callMcpTool(
  input: Record<string, unknown>,
  context: {turnId: string; toolCallId: string},
  tool: McpAgentTool,
): restate.Operation<
  | {status: "succeeded"; value: CallToolResult}
  | {status: "failed"; error: string}
> {
  return yield* restate.run(
    async ({signal}) => {
      let token: string | undefined;
      try {
        token = resolveMcpToken(tool.target.server);
        const connection = await connectMcp(
          tool.target.server,
          token,
          signal,
          tool.target.prior,
        );
        try {
          const value = await connection.client.callTool(
            {name: tool.target.remoteName, arguments: input},
            {
              signal,
              timeout: tool.target.server.timeoutMs,
              maxTotalTimeout: tool.target.server.timeoutMs,
              toolDefinition: tool.target.definition,
              headers: {
                "Idempotency-Key": `${context.turnId}:${context.toolCallId}`,
              },
            },
          );
          return {status: "succeeded" as const, value};
        } finally {
          if (tool.target.server.protocol === "stateless") {
            await connection.client.close();
          }
        }
      } catch (error) {
        if (tool.target.server.protocol === "stateful")
          await discardStatefulConnection(tool.target.server, token);
        signal.throwIfAborted();
        if (isCancellation(error)) throw error;
        // Provider errors can contain Authorization headers. Sanitize before
        // the failed HTTP effect is recorded in the journal.
        return {status: "failed" as const, error: sanitizedMessage(error)};
      }
    },
    {
      name: `mcp-tool-${tool.name}`,
      // MCP does not standardize idempotency. Avoid eager network retries;
      // crash recovery can still repeat an uncommitted remote side effect.
      retry: {maxAttempts: 1},
    },
  );
}

function* discoverMcpServer(
  config: McpServer,
  context: {agentId: string; turnId: string},
): restate.Operation<McpDiscoveryResult> {
  const server: McpServerSnapshot = {
    ...config,
    turnId: context.turnId,
    timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  };
  return yield* restate.run(
    async ({signal}) => {
      // Discovery is a read, so a transient network failure is retried here,
      // inside the effect. Letting Restate retry would require throwing out of
      // the run, and the last attempt's error text would then be journaled;
      // this way only the sanitized warning below is ever recorded.
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await discoverCached(config, server, signal);
          return {
            warnings: result.warnings,
            ...(result.catalog ? {catalog: {...result.catalog, server}} : {}),
          };
        } catch (error) {
          signal.throwIfAborted();
          if (isCancellation(error)) throw error;
          if (attempt < DISCOVERY_ATTEMPTS && isTransient(error)) {
            await sleep(DISCOVERY_BACKOFF_MS * 4 ** (attempt - 1), undefined, {
              signal,
            });
            continue;
          }
          return {warnings: [`${config.id}: ${sanitizedMessage(error)}`]};
        }
      }
    },
    {name: `discover-mcp-${config.id}`, retry: {maxAttempts: 1}},
  );
}

async function discoverCached(
  config: McpServer,
  server: McpServerSnapshot,
  signal: AbortSignal,
): Promise<McpCachedDiscoveryResult> {
  const token = resolveMcpToken(server);
  const fetch = () =>
    fetchCatalog(config, server, token).then(({catalog, ttlMs, warnings}) => ({
      value: catalog,
      ttlMs: Math.min(ttlMs, MAX_CACHE_TTL_MS),
      warnings,
    }));
  // A stateful catalog belongs to its session, so it is never shared.
  const {value, warnings} =
    config.protocol === "stateful"
      ? await abortable(fetch(), signal)
      : await catalogs.get(
          catalogCacheKey(config, token),
          fetch,
          (error) =>
            `${config.id}: refresh failed; using the last known catalog: ${sanitizedMessage(error)}`,
          signal,
        );
  return {catalog: value, warnings};
}

async function fetchCatalog(
  config: McpServer,
  server: McpServerSnapshot,
  token: string | undefined,
): Promise<{
  catalog: McpCatalogDefinition;
  ttlMs: number;
  warnings: string[];
}> {
  const signal = AbortSignal.timeout(server.timeoutMs);
  const connection = await connectMcp(
    server,
    token,
    signal,
    server.protocol === "stateful" ? {kind: "legacy"} : undefined,
  );
  try {
    const listed = await connection.client.listTools(undefined, {
      cacheMode: "refresh",
      signal,
      timeout: server.timeoutMs,
    });
    const prior = protocolPrior(connection.client, server.protocol);

    const tools = listed.tools;
    const warnings: string[] = [];
    if (tools.length > MAX_TOOLS_PER_SERVER) {
      warnings.push(
        `${config.id}: exposed the first ${MAX_TOOLS_PER_SERVER} tools from a larger catalog`,
      );
    }
    const catalog = {
      prior,
      tools: tools
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_TOOLS_PER_SERVER),
    };
    return {
      catalog,
      ttlMs: prior.kind === "modern" ? cacheTtl(listed, prior.discover) : 0,
      warnings,
    };
  } catch (error) {
    if (server.protocol === "stateful") {
      await discardStatefulConnection(server, token);
    }
    throw error;
  } finally {
    if (server.protocol === "stateless") {
      await connection.client.close();
    }
  }
}

function createClient(
  token: string | undefined,
  timeoutMs: number,
  protocol: McpServer["protocol"],
): Client {
  return new Client(MCP_CLIENT, {
    capabilities: {},
    inputRequired: {autoFulfill: false},
    versionNegotiation: {
      mode: protocol === "stateless" ? {pin: MCP_PROTOCOL_VERSION} : "legacy",
      ...(protocol === "stateless" ? {probe: {timeoutMs, maxRetries: 0}} : {}),
    },
    cachePartition: token ? tokenFingerprint(token) : "anonymous",
    listMaxPages: 64,
  });
}

async function connectMcp(
  server: McpServerSnapshot,
  token: string | undefined,
  signal: AbortSignal,
  prior: PriorDiscovery | undefined,
): Promise<McpConnection> {
  if (server.protocol === "stateless") {
    return openMcpConnection(server, token, signal, prior);
  }

  const key = statefulConnectionKey(server, token);
  const existing = statefulConnections.get(key);
  if (existing) {
    return existing.connection;
  }

  const pending = openMcpConnection(
    server,
    token,
    signal,
    prior ?? {kind: "legacy"},
  ).catch((error: unknown) => {
    statefulConnections.delete(key);
    throw error;
  });
  statefulConnections.set(key, {turnId: server.turnId, connection: pending});
  return pending;
}

async function openMcpConnection(
  server: McpServerSnapshot,
  token: string | undefined,
  signal: AbortSignal,
  prior: PriorDiscovery | undefined,
): Promise<McpConnection> {
  const client = createClient(token, server.timeoutMs, server.protocol);
  const transport = createTransport(server, token);
  try {
    await client.connect(transport, {
      ...(prior ? {prior} : {}),
      signal,
      timeout: server.timeoutMs,
    });
    return {client};
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

function createTransport(
  server: McpServerSnapshot,
  token: string | undefined,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(server.url), {
    ...(token ? {authProvider: {token: async () => token}} : {}),
    fetch: noRedirectFetch,
    onInsufficientScope: "throw",
  });
}

function noRedirectFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, {...init, redirect: "error"});
}

function statefulConnectionKey(
  server: McpServerSnapshot,
  token: string | undefined,
): string {
  return JSON.stringify([
    server.turnId,
    server.id,
    server.url,
    token ? tokenFingerprint(token) : "anonymous",
  ]);
}

async function closeStatefulConnections(turnId: string): Promise<void> {
  const connections = [...statefulConnections.entries()].filter(
    ([, connection]) => connection.turnId === turnId,
  );
  for (const [key] of connections) {
    statefulConnections.delete(key);
  }
  await Promise.allSettled(
    connections.map(([, {connection}]) =>
      connection.then(({client}) => client.close()),
    ),
  );
}

async function discardStatefulConnection(
  server: McpServerSnapshot,
  token: string | undefined,
): Promise<void> {
  const key = statefulConnectionKey(server, token);
  const connection = statefulConnections.get(key);
  if (!connection) return;
  statefulConnections.delete(key);
  await connection.connection
    .then(({client}) => client.close())
    .catch(() => {});
}

/** Releases process-local stateful MCP sessions when their owning Turn ends. */
export function* releaseMcpSessions(turnId: string): restate.Operation<void> {
  yield* restate.run(() => closeStatefulConnections(turnId), {
    name: "release-mcp-sessions",
    retry: {maxAttempts: 1},
  });
}

/** Best-effort cleanup when the owning Restate invocation is already cancelled. */
export function releaseMcpSessionsAfterCancellation(turnId: string): void {
  void closeStatefulConnections(turnId);
}

function catalogCacheKey(config: McpServer, token: string | undefined): string {
  return JSON.stringify([
    config.id,
    config.url,
    config.protocol,
    config.tokenEnv,
    token ? tokenFingerprint(token) : "anonymous",
  ]);
}

function protocolPrior(
  client: Client,
  protocol: McpServer["protocol"],
): PriorDiscovery {
  if (protocol === "stateful") {
    return {kind: "legacy"};
  }
  const discovery = client.getDiscoverResult();
  if (!discovery) {
    throw new Error("server did not return a stateless discovery result");
  }
  return {kind: "modern", discover: discovery};
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function uniqueModelName(
  serverId: string,
  remoteName: string,
  reserved: Set<string>,
): string {
  const normalized = `mcp__${serverId}__${remoteName}`.replace(
    /[^A-Za-z0-9_-]/g,
    "_",
  );
  if (normalized.length <= MAX_MODEL_TOOL_NAME && !reserved.has(normalized)) {
    return normalized;
  }

  const suffix = `__${createHash("sha256")
    .update(`${serverId}\0${remoteName}`)
    .digest("hex")
    .slice(0, 8)}`;
  const shortened = `${normalized.slice(0, MAX_MODEL_TOOL_NAME - suffix.length)}${suffix}`;
  if (!reserved.has(shortened)) {
    return shortened;
  }

  // The remote identity hash makes this practically unreachable, but retain a
  // deterministic collision path rather than letting one tool replace another.
  let attempt = 2;
  while (true) {
    const attemptSuffix = `_${attempt}`;
    const candidate = `${shortened.slice(0, MAX_MODEL_TOOL_NAME - attemptSuffix.length)}${attemptSuffix}`;
    if (!reserved.has(candidate)) {
      return candidate;
    }
    attempt += 1;
  }
}

function modelDescription(serverId: string, tool: Tool): string {
  const description =
    tool.description?.trim() ||
    tool.title?.trim() ||
    `Invoke ${tool.name} on the ${serverId} MCP server.`;
  const qualified = `${description}\n\nProvided by configured MCP server ${serverId}.`;
  return qualified.length <= MAX_DESCRIPTION_CHARS
    ? qualified
    : `${qualified.slice(0, MAX_DESCRIPTION_CHARS - 16)}… [truncated]`;
}

function cacheTtl(listed: unknown, discovery: DiscoverResult): number {
  const listTtl = readTtl(listed);
  const discoveryTtl = readTtl(discovery);
  return Math.min(listTtl, discoveryTtl);
}

function readTtl(value: unknown): number {
  if (typeof value !== "object" || value === null || !("ttlMs" in value)) {
    return 0;
  }
  const ttl = (value as {ttlMs?: unknown}).ttlMs;
  return typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0
    ? Math.floor(ttl)
    : 0;
}

function renderToolResult(result: CallToolResult): string {
  const content = result.content.map((block) => {
    switch (block.type) {
      case "text":
        return block;
      case "image":
      case "audio":
        return {
          type: block.type,
          mimeType: block.mimeType,
          omittedBase64Characters: block.data.length,
          ...(block.annotations ? {annotations: block.annotations} : {}),
        };
      case "resource":
        return "blob" in block.resource
          ? {
              type: block.type,
              resource: {
                uri: block.resource.uri,
                ...(block.resource.mimeType
                  ? {mimeType: block.resource.mimeType}
                  : {}),
                omittedBase64Characters: block.resource.blob.length,
                ...(block.annotations ? {annotations: block.annotations} : {}),
              },
            }
          : block;
      case "resource_link":
        return block;
      default:
        return {type: "unsupported"};
    }
  });
  const rendered = JSON.stringify({
    ...(result.structuredContent !== undefined
      ? {structuredContent: result.structuredContent}
      : {}),
    content,
  });
  if (rendered.length <= MAX_RESULT_CHARS) {
    return rendered;
  }
  return JSON.stringify({
    truncated: true,
    originalCharacters: rendered.length,
    preview: rendered.slice(0, MAX_RESULT_CHARS - 100),
  });
}

/** Configuration and authorization failures do not heal by retrying. */
function isTransient(error: unknown): boolean {
  return !(
    error instanceof McpConfigurationError ||
    UnauthorizedError.isInstance(error) ||
    InsufficientScopeError.isInstance(error)
  );
}

// Provider errors can carry credentials, so only fixed messages are journaled.
function sanitizedMessage(error: unknown): string {
  if (error instanceof McpConfigurationError) return error.message;
  if (
    UnauthorizedError.isInstance(error) ||
    InsufficientScopeError.isInstance(error)
  )
    return "MCP authorization failed; check the configured credential";
  return "MCP request failed; check the configured endpoint and credential";
}
