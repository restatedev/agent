// Restate handlers annotated with `restate.dev/agent`, discovered through the
// Admin API. Used by turns and by the Agent's tool catalog.

import {restateTools} from "@restate-agents/core/discovery";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

import {names} from "./tools.js";
import type {TurnContext, TurnTool} from "./turn-context.js";

/** A discovered tool and its stable `service/handler` permission ID. */
export type DiscoveredTool = {id: string; tool: TurnTool};

const permissionId = ({service, handler}: {service: string; handler: string}) =>
  `${service}/${handler}`;

/** Discovers permitted handlers; an unreachable Admin API degrades to none. */
export function* discoverRestateTools(
  allow: (id: string) => boolean,
): restate.Operation<Record<string, DiscoveredTool>> {
  try {
    const {tools, targets, warnings} = yield* restateTools<TurnContext>({
      adminUrl: process.env.RESTATE_ADMIN_URL ?? "http://localhost:9070",
      *token() {
        return process.env.RESTATE_ADMIN_TOKEN;
      },
      reservedNames: names,
      allow: (target) => allow(permissionId(target)),
    });
    for (const warning of warnings) restate.logger().warn(warning);
    return Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [
        name,
        {id: permissionId(targets[name]!), tool},
      ]),
    );
  } catch (error) {
    // Discovery retries transient failures before failing terminally.
    if (!(error instanceof TerminalError)) throw error;
    restate.logger().warn(`Restate tool discovery failed: ${error.message}`);
    return {};
  }
}
