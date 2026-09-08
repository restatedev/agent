// Durable profile for one Agent virtual object. Instructions, guardrails, and
// MCP servers and web search are user-managed configuration; memories are a
// bounded keyed collection managed by the model through an Agent handler.

import type {
  AgentProfile,
  Guardrail,
  McpServer,
  McpServerMutationResult,
  MemoryChange,
  MemoryEntry,
} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import type {MemoryUpdateResult} from "../internal-types.js";

const INSTRUCTIONS = "profile/instructions";
const MEMORIES = "profile/memories";
const GUARDRAILS = "profile/guardrails";
const MCP_SERVERS = "profile/mcp-servers";
const WEB_SEARCH_ENABLED = "profile/web-search-enabled";
const MAX_MEMORIES = 32;
const MAX_MCP_SERVERS = 16;

/**
 * Handler-scoped access to persistent profile state for the current Agent.
 *
 * Mutations rely on exclusive Agent handler serialization. A Turn receives a
 * snapshot and never reads this state directly.
 */
export function* read(): restate.Operation<AgentProfile> {
  const [instructions, memories, guardrails, mcpServers, webSearchEnabled] =
    yield* restate.all([
      restate.sharedState().get<string>(INSTRUCTIONS),
      restate.sharedState().get<MemoryEntry[]>(MEMORIES),
      restate.sharedState().get<Guardrail[]>(GUARDRAILS),
      restate.sharedState().get<McpServer[]>(MCP_SERVERS),
      restate.sharedState().get<boolean>(WEB_SEARCH_ENABLED),
    ]);
  return {
    ...(instructions ? {instructions} : {}),
    memories: memories ?? [],
    guardrails: guardrails ?? [],
    mcpServers: mcpServers ?? [],
    webSearchEnabled: webSearchEnabled ?? true,
  };
}

/** Controls the built-in web search capability for future turns. */
export function setWebSearchEnabled(enabled: boolean): void {
  restate.state().set(WEB_SEARCH_ENABLED, enabled);
}

/** Replaces or clears the persistent user-authored instructions. */
export function setInstructions(instructions: string | null): void {
  const value = instructions?.trim();
  if (value) {
    restate.state().set(INSTRUCTIONS, value);
  } else {
    restate.state().clear(INSTRUCTIONS);
  }
}

/** Replaces the complete user-authored natural-language policy set. */
export function setGuardrails(guardrails: Guardrail[]): void {
  if (guardrails.length > 0) {
    restate.state().set(GUARDRAILS, guardrails);
  } else {
    restate.state().clear(GUARDRAILS);
  }
}

/** Creates or replaces one user-configured MCP server by stable ID. */
export function* upsertMcpServer(
  server: McpServer,
): restate.Operation<McpServerMutationResult> {
  const servers =
    (yield* restate.sharedState().get<McpServer[]>(MCP_SERVERS)) ?? [];
  const index = servers.findIndex(({id}) => id === server.id);
  if (index < 0 && servers.length >= MAX_MCP_SERVERS) {
    return {
      accepted: false,
      error: `MCP servers are limited to ${MAX_MCP_SERVERS} entries`,
    };
  }

  if (index < 0) {
    servers.push(server);
  } else {
    servers[index] = server;
  }
  restate.state().set(MCP_SERVERS, servers);
  return {accepted: true, replaced: index >= 0, server};
}

/** Removes one configured MCP server when it exists. */
export function* removeMcpServer(id: string): restate.Operation<boolean> {
  const servers =
    (yield* restate.sharedState().get<McpServer[]>(MCP_SERVERS)) ?? [];
  const index = servers.findIndex((server) => server.id === id);
  if (index < 0) {
    return false;
  }
  servers.splice(index, 1);
  if (servers.length === 0) {
    restate.state().clear(MCP_SERVERS);
  } else {
    restate.state().set(MCP_SERVERS, servers);
  }
  return true;
}

/** Atomically applies model-requested changes to the bounded Agent memory. */
export function* applyMemory(
  changes: MemoryChange[],
): restate.Operation<MemoryUpdateResult> {
  const memories =
    (yield* restate.sharedState().get<MemoryEntry[]>(MEMORIES)) ?? [];
  const updated = [...memories];

  for (const change of changes) {
    const index = updated.findIndex(({key}) => key === change.key);
    if (change.operation === "delete") {
      if (index >= 0) {
        updated.splice(index, 1);
      }
    } else if (index >= 0) {
      updated[index] = {key: change.key, content: change.content};
    } else {
      updated.push({key: change.key, content: change.content});
    }
  }

  if (updated.length > MAX_MEMORIES) {
    return {
      applied: false,
      error: `memory is limited to ${MAX_MEMORIES} entries`,
    };
  }

  if (updated.length > 0) {
    restate.state().set(MEMORIES, updated);
  } else {
    restate.state().clear(MEMORIES);
  }
  return {applied: true, memoryCount: updated.length};
}
