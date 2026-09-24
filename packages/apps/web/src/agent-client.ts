import type {
  AgentMetadata,
  AgentNotificationSnapshot,
  AgentProfile,
  ApprovalRequest,
  ApprovalResolution,
  AskResult,
  ChildAgent,
  HistoryPage,
  ProfileUpdate,
  ScheduleCancellationResult,
  ScheduledMessage,
  ToolCatalog,
} from "@restate-agents/types";

export type {SequencedEntry} from "@restate-agents/client";
export type AgentSnapshot = {
  notification: AgentNotificationSnapshot;
  profile: AgentProfile;
  approvals: ApprovalRequest[];
  schedules: ScheduledMessage[];
  metadata: AgentMetadata;
  children: ChildAgent[];
  history: HistoryPage;
};
export type AgentSnapshotUpdate = Pick<AgentSnapshot, "notification"> &
  Partial<Omit<AgentSnapshot, "notification">>;

type RequestOptions = {
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

class AgentClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentClientError";
  }
}

async function request<T>(path: string, options: RequestOptions = {}) {
  const response = await fetch(path, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      ...(options.body === undefined
        ? {}
        : {"content-type": "application/json"}),
      ...(options.idempotencyKey
        ? {"idempotency-key": options.idempotencyKey}
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    signal: options.signal,
  });
  const text = await response.text();
  const result = text ? (JSON.parse(text) as T | {message?: string}) : null;
  if (!response.ok) {
    throw new AgentClientError(
      response.status,
      (result && typeof result === "object" && "message" in result
        ? result.message
        : undefined) ?? `${response.status} ${response.statusText}`,
    );
  }
  return result as T;
}

/**
 * Browser-side operations on one agent through this app's
 * `/api/agent/{agentId}/{operation}` proxy (see its route handler): a subset
 * of `@restate-agents/client`, plus `snapshot` and `sync`, which batch the
 * reads a page render needs. Rejected calls throw with the proxy's status.
 */
export type AgentClient = ReturnType<typeof createAgentClient>;

export function createAgentClient(agentId: string) {
  const base = `/api/agent/${encodeURIComponent(agentId)}`;
  const read = <T>(operation: string) => request<T>(`${base}/${operation}`);
  const write = <T>(operation: string, body: unknown) =>
    request<T>(`${base}/${operation}`, {body});

  return {
    /** Loads everything the conversation view renders. */
    snapshot(options?: {signal?: AbortSignal}): Promise<AgentSnapshot> {
      return request(`${base}/snapshot`, options);
    },
    /**
     * Waits for notifications newer than `since`, then returns only the parts
     * that changed, with history from `fromSequence`.
     */
    sync(
      since: AgentNotificationSnapshot,
      fromSequence: number,
      options?: {idempotencyKey?: string; signal?: AbortSignal},
    ): Promise<AgentSnapshotUpdate> {
      return request(
        `${base}/sync?${new URLSearchParams({
          since: JSON.stringify(since),
          fromSequence: String(fromSequence),
        })}`,
        options,
      );
    },
    /** Starts a turn when the agent is idle, or queues the message. */
    ask: (message?: string) => write<AskResult>("ask", {message}),
    /** Redirects the active turn. @returns false when no turn is listening. */
    steer: (message: string) => write<boolean>("steer", {message}),
    /** Stops the active turn, optionally queueing a replacement message. */
    interrupt: (reason: string, message?: string) =>
      write<boolean>("interrupt", {reason, ...(message ? {message} : {})}),
    profile: () => read<AgentProfile>("profile"),
    updateProfile: (update: ProfileUpdate) => write<null>("profile", update),
    toolCatalog: () => read<ToolCatalog>("tool-catalog"),
    /** @returns whether the memory existed. */
    deleteMemory: (key: string) => write<boolean>("delete-memory", {key}),
    cancelSchedule: (scheduleId: string) =>
      write<ScheduleCancellationResult>("cancel-schedule", {scheduleId}),
    /** @returns false when the request or its turn is no longer eligible. */
    resolveApproval: (resolution: ApprovalResolution) =>
      write<boolean>("resolve-approval", resolution),
  };
}
