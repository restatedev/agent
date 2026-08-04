// Restate-native dynamic tool discovery. A third-party handler opts in by
// publishing `restate.dev/agent: <tool-name>` in its handler metadata. Each
// Turn journals one catalog snapshot and uses it for both model inference and
// invocation, so deployment changes cannot split those two decisions. Admin
// reads are coalesced in a short-lived cache local to each endpoint process.

import {CancelledError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";

const AGENT_TOOL_ANNOTATION = "restate.dev/agent";

type JsonSchema = boolean | Record<string, unknown>;

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

type DiscoveryResult = {
  tools: DiscoveredAgentTool[];
  warnings: string[];
};

let cachedCatalog:
  | {
      tools: DiscoveredAgentTool[];
      refreshAfter: number;
    }
  | undefined;
let refreshInFlight: Promise<DiscoveryResult> | undefined;

function jsonSchema(value: unknown): JsonSchema | undefined {
  return typeof value === "boolean" ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
    ? (value as JsonSchema)
    : undefined;
}

function nestedInputSchema(schema: JsonSchema): JsonSchema {
  if (typeof schema === "boolean") {
    return schema;
  }
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(rewrite);
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        (key === "$ref" || key === "$dynamicRef") &&
        typeof child === "string" &&
        child.startsWith("#")
          ? `#/properties/input${child.slice(1)}`
          : rewrite(child),
      ]),
    );
  };
  return rewrite(schema) as Record<string, unknown>;
}

function modelInputSchema(
  inputSchema: JsonSchema | undefined,
  keyed: boolean,
): Record<string, unknown> {
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
  if (inputSchema !== undefined) {
    // The handler schema becomes the `input` property of the model tool. Keep
    // local JSON pointers valid after moving that schema below a new root.
    properties.input = nestedInputSchema(inputSchema);
    required.push("input");
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function adminUrl(): string {
  return (process.env.RESTATE_ADMIN_URL ?? DEFAULT_ADMIN_URL).replace(
    /\/+$/,
    "",
  );
}

async function fetchTools(
  reservedNames: string[],
  signal: AbortSignal,
): Promise<DiscoveryResult> {
  const headers: Record<string, string> = {accept: "application/json"};
  const token = process.env.RESTATE_ADMIN_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${adminUrl()}/services`, {headers, signal});
  if (!response.ok) {
    throw new Error(
      `Restate Admin API returned ${response.status} ${response.statusText}`,
    );
  }

  const {services} = ServicesResponseSchema.parse(await response.json());
  const reserved = new Set(reservedNames);
  const tools: DiscoveredAgentTool[] = [];
  const warnings: string[] = [];

  // Admin API ordering is not part of the tool contract. Sort targets so a
  // duplicate annotation is resolved consistently within a fresh Turn.
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
    const annotatedName = handler.metadata[AGENT_TOOL_ANNOTATION]?.trim();
    if (!annotatedName) {
      continue;
    }
    const target = `${service.name}/${handler.name}`;
    if (!TOOL_NAME.test(annotatedName)) {
      warnings.push(
        `ignored ${target}: ${AGENT_TOOL_ANNOTATION} must be a 1-64 character model tool name`,
      );
      continue;
    }
    if (reserved.has(annotatedName)) {
      warnings.push(
        `ignored ${target}: tool name ${annotatedName} is already registered`,
      );
      continue;
    }

    const discoveredInput = jsonSchema(handler.input_json_schema);
    const keyed = service.ty !== "Service";
    tools.push({
      name: annotatedName,
      description:
        handler.documentation?.trim() ||
        `Invoke ${target} as a durable Restate handler.`,
      inputSchema: modelInputSchema(discoveredInput, keyed),
      target: {
        service: service.name,
        handler: handler.name,
        keyed,
        acceptsInput: discoveredInput !== undefined,
      },
    });
    reserved.add(annotatedName);
  }

  return {tools, warnings};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForRefresh(
  refresh: Promise<DiscoveryResult>,
  signal: AbortSignal,
): Promise<DiscoveryResult> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ??
        new DOMException("The operation was aborted", "AbortError"),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(
        signal.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, {once: true});
    refresh.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function startRefresh(reservedNames: string[]): Promise<DiscoveryResult> {
  // The Admin GET is shared by independent Turn runs, so its lifetime is
  // process-bounded rather than owned by whichever Turn first noticed expiry.
  // Each caller still stops waiting on its own run AbortSignal.
  const refresh = fetchTools(
    reservedNames,
    AbortSignal.timeout(ADMIN_REQUEST_TIMEOUT_MS),
  )
    .then((result) => {
      cachedCatalog = {
        tools: result.tools,
        refreshAfter: Date.now() + REFRESH_INTERVAL_MS,
      };
      return result;
    })
    .catch((error: unknown) => {
      if (!cachedCatalog) {
        throw error;
      }
      cachedCatalog.refreshAfter = Date.now() + REFRESH_RETRY_INTERVAL_MS;
      return {
        tools: cachedCatalog.tools,
        warnings: [
          `Admin API refresh failed; using the last known catalog: ${errorMessage(error)}`,
        ],
      };
    })
    .finally(() => {
      refreshInFlight = undefined;
    });
  refreshInFlight = refresh;
  return refresh;
}

async function cachedTools(
  reservedNames: string[],
  signal: AbortSignal,
): Promise<DiscoveryResult> {
  if (cachedCatalog && Date.now() < cachedCatalog.refreshAfter) {
    return {tools: cachedCatalog.tools, warnings: []};
  }
  if (refreshInFlight) {
    // One request refreshes this endpoint replica. Other Turns keep using the
    // last known-good snapshot instead of accumulating behind network I/O.
    if (cachedCatalog) {
      return {tools: cachedCatalog.tools, warnings: []};
    }
    const result = await waitForRefresh(refreshInFlight, signal);
    // Only the Turn that initiated a cold refresh reports catalog warnings.
    return {tools: result.tools, warnings: []};
  }
  return waitForRefresh(startRefresh(reservedNames), signal);
}

export function* discoverAgentTools(
  reservedNames: string[],
): restate.Operation<DiscoveredAgentTool[]> {
  try {
    const result = yield* restate.run(
      ({signal}) => cachedTools(reservedNames, signal),
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
    for (const warning of result.warnings) {
      restate.logger().warn(`Dynamic tool discovery: ${warning}`);
    }
    return result.tools;
  } catch (error) {
    if (
      error instanceof restate.InterruptedError ||
      error instanceof CancelledError
    ) {
      throw error;
    }
    restate
      .logger()
      .warn(
        `Dynamic tool discovery unavailable; continuing with built-in tools: ${errorMessage(error)}`,
      );
    return [];
  }
}
