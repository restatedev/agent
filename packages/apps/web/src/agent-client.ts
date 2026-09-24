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

export type SequencedEntry = HistoryPage["entries"][number];
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

/**
 * Browser-side operations on one agent through this app's
 * `/api/agent/{agentId}/{operation}` proxy (see its route handler). A subset of
 * the ingress client in `@restate-agents/client`, plus `snapshot`/`sync`,
 * which batch the reads a page render needs. Rejected calls throw an error
 * carrying the proxy's HTTP status.
 */
export interface AgentClient {
  /** Loads everything the conversation view renders. */
  snapshot(options?: {signal?: AbortSignal}): Promise<AgentSnapshot>;

  /**
   * Waits for notifications newer than `since`, then returns only the parts
   * that changed, with history from `fromSequence`.
   */
  sync(
    since: AgentNotificationSnapshot,
    fromSequence: number,
    options?: {idempotencyKey?: string; signal?: AbortSignal},
  ): Promise<AgentSnapshotUpdate>;

  /** Starts a turn when the agent is idle, or queues the message. */
  ask(message?: string): Promise<AskResult>;

  /** Redirects the active turn. @returns false when no turn is listening. */
  steer(message: string): Promise<boolean>;

  /** Stops the active turn, optionally queueing a replacement message. */
  interrupt(reason: string, message?: string): Promise<boolean>;

  profile(): Promise<AgentProfile>;
  updateProfile(update: ProfileUpdate): Promise<void>;
  toolCatalog(): Promise<ToolCatalog>;

  /** @returns whether the memory existed. */
  deleteMemory(key: string): Promise<boolean>;

  cancelSchedule(scheduleId: string): Promise<ScheduleCancellationResult>;

  /** @returns false when the request or its turn is no longer eligible. */
  resolveApproval(resolution: ApprovalResolution): Promise<boolean>;
}

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

export function createAgentClient(agentId: string): AgentClient {
  const base = `/api/agent/${encodeURIComponent(agentId)}`;
  const read = <T>(operation: string, parameters?: URLSearchParams) =>
    request<T>(`${base}/${operation}${parameters ? `?${parameters}` : ""}`);
  const write = <T>(operation: string, body: unknown) =>
    request<T>(`${base}/${operation}`, {body});

  return {
    async snapshot(options?: {signal?: AbortSignal}): Promise<AgentSnapshot> {
      return request(`${base}/snapshot`, options);
    },
    async sync(
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
    async ask(message?: string): Promise<AskResult> {
      return write("ask", {message});
    },
    async steer(message: string): Promise<boolean> {
      return write("steer", {message});
    },
    async interrupt(reason: string, message?: string): Promise<boolean> {
      return write("interrupt", {reason, ...(message ? {message} : {})});
    },
    async profile(): Promise<AgentProfile> {
      return read("profile");
    },
    async updateProfile(update: ProfileUpdate): Promise<void> {
      await write("profile", update);
    },
    async toolCatalog(): Promise<ToolCatalog> {
      return read("tool-catalog");
    },
    async deleteMemory(key: string): Promise<boolean> {
      return write("delete-memory", {key});
    },
    async cancelSchedule(
      scheduleId: string,
    ): Promise<ScheduleCancellationResult> {
      return write("cancel-schedule", {scheduleId});
    },
    async resolveApproval(resolution: ApprovalResolution): Promise<boolean> {
      return write("resolve-approval", resolution);
    },
  };
}
