// Restate-native dynamic tool discovery. A third-party handler opts in by
// publishing `restate.dev/agent: <tool-name>` in its handler metadata. Each
// Turn journals one catalog snapshot and uses it for both model inference and
// invocation, so deployment changes cannot split those two decisions. Admin
// reads are coalesced in a short-lived cache local to each endpoint process.

import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";

import {errorMessage, isCancellation} from "../errors.js";
import {createRefreshingCache} from "../refresh-cache.js";

const AGENT_TOOL_ANNOTATION = "restate.dev/agent";

type JsonSchema = boolean | Record<string, unknown>;

/** A deployed Restate handler projected into the agent's tool protocol. */
export type DiscoveredAgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  target: {
    service: string;
    handler: string;
    keyed: boolean;
    acceptsInput: boolean;
  };
};

const HandlerMetadataSchema = z.object({
  name: z.string(),
  documentation: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).default({}),
  input_json_schema: z.unknown().optional(),
});

const ServiceMetadataSchema = z.object({
  name: z.string(),
  ty: z.string(),
  handlers: z.array(HandlerMetadataSchema),
});

const ServicesResponseSchema = z.object({
  services: z.array(ServiceMetadataSchema),
});

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_ADMIN_URL = "http://localhost:9070";
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const REFRESH_RETRY_INTERVAL_MS = 30 * 1_000;
const ADMIN_REQUEST_TIMEOUT_MS = 5 * 1_000;

// Admin reads are coalesced per endpoint process.
const catalog = createRefreshingCache<DiscoveredAgentTool[]>({
  retryAfterMs: REFRESH_RETRY_INTERVAL_MS,
});

/** Calls one discovered handler with the model's `{key?, input?}` object. */
export function* executeDynamicTool(
  fields: Record<string, unknown>,
  tool: DiscoveredAgentTool,
): restate.Operation<
  {status: "succeeded"; result: string} | {status: "failed"; error: string}
> {
  const {service, handler, keyed, acceptsInput} = tool.target;
  if (keyed && (typeof fields.key !== "string" || fields.key.length === 0))
    return {
      status: "failed",
      error: "dynamic Virtual Object and Workflow tools require a key",
    };
  if (acceptsInput && !("input" in fields))
    return {status: "failed", error: "dynamic tool input is missing input"};
  try {
    const result = yield* restate.call<unknown, unknown>({
      service,
      method: handler,
      ...(keyed ? {key: fields.key as string} : {}),
      parameter: acceptsInput ? fields.input : undefined,
      inputSerde: restate.serde.json,
      outputSerde: restate.serde.json,
      name: `dynamic-tool-${tool.name}`,
    });
    return {
      status: "succeeded",
      result:
        typeof result === "string"
          ? result
          : (JSON.stringify(result) ?? "Handler completed without a result"),
    };
  } catch (error) {
    if (isCancellation(error)) throw error;
    return {
      status: "failed",
      error: `${tool.name} failed: ${errorMessage(error)}`,
    };
  }
}

/**
 * Discovers annotated Restate handlers and journals one catalog snapshot, so
 * model inference and invocation see the same catalog for the whole turn.
 * An unavailable Admin API leaves the turn with built-in tools only.
 */
export function* discoverAgentTools(
  reservedNames: string[],
): restate.Operation<DiscoveredAgentTool[]> {
  try {
    const result = yield* restate.run(
      ({signal}) =>
        catalog.get(
          "admin",
          async () => ({
            ...projectTools(await readServices(), reservedNames),
            ttlMs: REFRESH_INTERVAL_MS,
          }),
          (error) =>
            `Admin API refresh failed; using the last known catalog: ${errorMessage(error)}`,
          signal,
        ),
      {
        name: "discover-agent-tools",
        retry: {
          maxAttempts: 3,
          initialInterval: 200,
          maxInterval: 2_000,
          exponentiationFactor: 2,
        },
      },
    );
    for (const warning of result.warnings)
      restate.logger().warn(`Dynamic tool discovery: ${warning}`);
    return result.value;
  } catch (error) {
    if (isCancellation(error)) throw error;
    restate
      .logger()
      .warn(
        `Dynamic tool discovery unavailable; continuing with built-in tools: ${errorMessage(error)}`,
      );
    return [];
  }
}

async function readServices(): Promise<
  z.infer<typeof ServiceMetadataSchema>[]
> {
  const headers: Record<string, string> = {accept: "application/json"};
  const token = process.env.RESTATE_ADMIN_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const adminUrl = (process.env.RESTATE_ADMIN_URL ?? DEFAULT_ADMIN_URL).replace(
    /\/+$/,
    "",
  );
  const response = await fetch(`${adminUrl}/services`, {
    headers,
    signal: AbortSignal.timeout(ADMIN_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(
      `Restate Admin API returned ${response.status} ${response.statusText}`,
    );
  return ServicesResponseSchema.parse(await response.json()).services;
}

function projectTools(
  services: z.infer<typeof ServiceMetadataSchema>[],
  reservedNames: string[],
): {value: DiscoveredAgentTool[]; warnings: string[]} {
  const reserved = new Set(reservedNames);
  const tools: DiscoveredAgentTool[] = [];
  const warnings: string[] = [];
  // Admin API ordering is not part of the tool contract. Sort targets so a
  // duplicate annotation is resolved consistently.
  const handlers = services
    .flatMap((service) =>
      service.handlers.map((handler) => ({service, handler})),
    )
    .sort((left, right) =>
      `${left.service.name}/${left.handler.name}`.localeCompare(
        `${right.service.name}/${right.handler.name}`,
      ),
    );
  for (const {service, handler} of handlers) {
    const name = handler.metadata[AGENT_TOOL_ANNOTATION]?.trim();
    if (!name) continue;
    const target = `${service.name}/${handler.name}`;
    if (!TOOL_NAME.test(name)) {
      warnings.push(
        `ignored ${target}: ${AGENT_TOOL_ANNOTATION} must be a 1-64 character model tool name`,
      );
      continue;
    }
    if (reserved.has(name)) {
      warnings.push(
        `ignored ${target}: tool name ${name} is already registered`,
      );
      continue;
    }
    tools.push(toTool(name, service, handler));
    reserved.add(name);
  }
  return {value: tools, warnings};
}

function toTool(
  name: string,
  service: z.infer<typeof ServiceMetadataSchema>,
  handler: z.infer<typeof HandlerMetadataSchema>,
): DiscoveredAgentTool {
  const input = handler.input_json_schema;
  const handlerInput =
    typeof input === "boolean" ||
    (typeof input === "object" && input !== null && !Array.isArray(input))
      ? (input as JsonSchema)
      : undefined;
  const keyed = service.ty !== "Service";
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (keyed) {
    properties.key = {
      type: "string",
      minLength: 1,
      description: "Virtual Object key or Workflow ID.",
    };
    required.push("key");
  }
  if (handlerInput !== undefined) {
    // The handler schema becomes the `input` property of the model tool.
    properties.input =
      typeof handlerInput === "boolean"
        ? handlerInput
        : rebaseRefs(handlerInput);
    required.push("input");
  }
  return {
    name,
    description:
      handler.documentation?.trim() ||
      `Invoke ${service.name}/${handler.name} as a durable Restate handler.`,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    target: {
      service: service.name,
      handler: handler.name,
      keyed,
      acceptsInput: handlerInput !== undefined,
    },
  };
}

// Rewrites local JSON pointers after moving a schema below `properties.input`.
function rebaseRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rebaseRefs);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      (key === "$ref" || key === "$dynamicRef") &&
      typeof child === "string" &&
      child.startsWith("#")
        ? `#/properties/input${child.slice(1)}`
        : rebaseRefs(child),
    ]),
  );
}
