import type {AgentNotificationSnapshot} from "@restate-agents/types";

// Type-only: the operation tables (and their zod schemas) stay on the server;
// the browser gets just the body and result types they declare.
import type {
  MutationBody,
  MutationResult,
  Mutations,
  ReadResult,
  Reads,
} from "./server/operations";

export type {SequencedEntry} from "@restate-agents/client";

/** A rejected proxy call, with the proxy's HTTP status. */
export class UiClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UiClientError";
  }
}

type RequestOptions = {
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

function requestHeaders(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.idempotencyKey) {
    headers["idempotency-key"] = options.idempotencyKey;
  }
  return headers;
}

/** The proxy reports failures as `{message}`; fall back to the status line. */
function failureMessage(response: Response, result: unknown) {
  if (result && typeof result === "object" && "message" in result) {
    return String(result.message);
  }
  return `${response.status} ${response.statusText}`;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const hasBody = options.body !== undefined;
  const response = await fetch(path, {
    method: hasBody ? "POST" : "GET",
    headers: requestHeaders(options),
    body: hasBody ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
    signal: options.signal,
  });
  const text = await response.text();
  const result: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new UiClientError(response.status, failureMessage(response, result));
  }
  return result as T;
}

/**
 * Browser-side operations on one agent through this app's
 * `/api/agent/{agentId}/{operation}` proxy. Operation names, bodies and
 * results come from the proxy's READS and MUTATIONS tables, so this file
 * only chooses method signatures. Rejected calls throw `UiClientError`.
 */
export type UiAgentClient = ReturnType<typeof createUiClient>;

export function createUiClient(agentId: string) {
  const base = `/api/agent/${encodeURIComponent(agentId)}`;

  function read<K extends keyof Reads>(
    operation: K,
    options: Omit<RequestOptions, "body"> & {query?: URLSearchParams} = {},
  ): Promise<ReadResult<K>> {
    const query = options.query ? `?${options.query}` : "";
    return request(`${base}/${operation}${query}`, options);
  }

  function write<K extends keyof Mutations>(
    operation: K,
    body: MutationBody<K>,
  ): Promise<MutationResult<K>> {
    return request(`${base}/${operation}`, {body});
  }

  return {
    /** Loads everything the conversation view renders. */
    snapshot(options?: {signal?: AbortSignal}) {
      return read("snapshot", options);
    },
    /**
     * Waits for notifications newer than `since`, then returns only the parts
     * that changed, with history from `fromSequence`.
     */
    sync(
      since: AgentNotificationSnapshot,
      fromSequence: number,
      options?: {idempotencyKey?: string; signal?: AbortSignal},
    ) {
      const query = new URLSearchParams({
        since: JSON.stringify(since),
        fromSequence: String(fromSequence),
      });
      return read("sync", {...options, query});
    },
    /** Starts a turn when the agent is idle, or queues the message. */
    ask(message: string) {
      return write("ask", {message});
    },
    /** Redirects the active turn. Resolves false when no turn is listening. */
    steer(message: string) {
      return write("steer", {message});
    },
    /** Stops the active turn, optionally queueing a replacement message. */
    interrupt(reason: string, message?: string) {
      if (message) {
        return write("interrupt", {reason, message});
      }
      return write("interrupt", {reason});
    },
    profile() {
      return read("profile");
    },
    updateProfile(update: MutationBody<"updateProfile">) {
      return write("updateProfile", update);
    },
    toolCatalog() {
      return read("toolCatalog");
    },
    /** Resolves whether the memory existed. */
    deleteMemory(id: string) {
      return write("deleteMemory", {id});
    },
    cancelSchedule(scheduleId: string) {
      return write("cancelSchedule", {scheduleId});
    },
    /** Resolves false when the request or its turn is no longer eligible. */
    resolveApproval(resolution: MutationBody<"resolveApproval">) {
      return write("resolveApproval", resolution);
    },
  };
}
