// Starting a turn. Every entry path (ask, delivery, queued successor,
// delegation) comes through startTurn, which snapshots the profile and hands
// the turn to active-turn. It has a module of its own because turn routing
// and sub-agent delegation both start turns, and sub-agents are stopped when
// a routed turn ends.

import type {ConversationEntry} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";

import {
  configuredMcpServers,
  grantedMcpServers,
  resolveMcpGrants,
} from "../session/mcp-config.js";
import * as activeTurn from "./active-turn.js";
import {readMetadata} from "./guards.js";
import * as profile from "./profile.js";

/**
 * Starts a turn from the current profile snapshot.
 *
 * @returns The turn ID.
 */
export function* startTurn(
  entries: ConversationEntry[],
): restate.Operation<string> {
  const {memories, ...config} = yield* profile.read();
  const metadata = yield* readMetadata();
  // Read configuration before any state change: an invalid configuration
  // throws, and state written by a failed invocation is not rolled back.
  const servers = yield* configuredMcpServers();
  // A direct ask implicitly creates the agent; persist its default metadata
  // so later initialization cannot change its parent.
  if (!(yield* restate.state().get("metadata")))
    restate.state().set("metadata", metadata);
  // Normally empty while idle. It holds a successor's input that onTurnEnd
  // could not start, which must open the next turn ahead of the new input.
  const parked = yield* activeTurn.drainPending();
  const tools = resolveMcpGrants(config.tools, servers);
  return yield* activeTurn.start({
    ...config,
    memoryCount: memories.length,
    agentName: metadata.name,
    tools,
    mcpServers: grantedMcpServers(tools, servers),
    entries: [...parked, ...entries],
  });
}
