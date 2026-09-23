import type {
  AgentMetadata,
  AgentNotificationSnapshot,
  AgentProfile,
  AgentTools,
  ApprovalRequest,
  ApprovalResolution,
  AskResult,
  ChildAgent,
  Guardrail,
  HistoryPage,
  McpServer,
  ScheduledMessage,
  ToolDescriptor,
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

export function createAgentClient(agentId: string) {
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
    async setInstructions(instructions: string | null): Promise<void> {
      await write("instructions", {instructions});
    },
    async setGuardrails(guardrails: Guardrail[]): Promise<void> {
      await write("guardrails", {guardrails});
    },
    async setWebSearchEnabled(enabled: boolean): Promise<void> {
      await write("web-search", {enabled});
    },
    async setTools(tools: AgentTools): Promise<void> {
      await write("tools", tools);
    },
    async toolCatalog(): Promise<{
      builtin: ToolDescriptor[];
      dynamic: ToolDescriptor[];
      mcp: McpServer[];
    }> {
      return read("tool-catalog");
    },
    async deleteMemory(key: string): Promise<boolean> {
      return write("delete-memory", {key});
    },
    async cancelSchedule(scheduleId: string): Promise<unknown> {
      return write("cancel-schedule", {scheduleId});
    },
    async resolveApproval(resolution: ApprovalResolution): Promise<boolean> {
      return write("resolve-approval", resolution);
    },
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
