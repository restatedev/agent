import type {
  AgentNotificationSnapshot,
  AgentProfile,
  ApprovalRequest,
  ApprovalResolution,
  AskResult,
  Guardrail,
  HistoryPage,
  McpAuthorizationRequest,
  McpServer,
  McpServerMutationResult,
  McpServerRemovalResult,
  ScheduleCancellationResult,
  ScheduledMessage,
  ScheduleMutationResult,
} from "@restate-agents/types";

export type SequencedEntry = HistoryPage["entries"][number];
export type ScheduleWhenBusy = ScheduledMessage["whenBusy"];

export type ScheduleSpecInput = {
  scheduleId: string;
  message: string;
  delaySeconds: number;
  repeatEverySeconds: number | null;
  whenBusy?: ScheduleWhenBusy;
};

type RequestOptions = {
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export class AgentClientError extends Error {
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
    async ask(message?: string): Promise<AskResult> {
      return write("ask", {message});
    },
    async steer(message: string): Promise<boolean> {
      return write("steer", {message});
    },
    async interrupt(reason: string, message?: string): Promise<boolean> {
      return write("interrupt", {reason, ...(message ? {message} : {})});
    },
    async history(fromSequence = 1, limit = 100): Promise<HistoryPage> {
      return read(
        "history",
        new URLSearchParams({
          fromSequence: String(fromSequence),
          limit: String(limit),
        }),
      );
    },
    async notifications(): Promise<AgentNotificationSnapshot> {
      return read("notifications");
    },
    async watchNotifications(
      afterRevision: number,
      timeoutSeconds: number,
      options?: {idempotencyKey?: string; signal?: AbortSignal},
    ): Promise<AgentNotificationSnapshot> {
      return request(
        `${base}/watch?${new URLSearchParams({
          afterRevision: String(afterRevision),
          timeoutSeconds: String(timeoutSeconds),
        })}`,
        options,
      );
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
    async upsertMcpServer(server: McpServer): Promise<McpServerMutationResult> {
      return write("mcp-server", server);
    },
    async removeMcpServer(id: string): Promise<McpServerRemovalResult> {
      return write("remove-mcp-server", {id});
    },
    async mcpAuthorizations(): Promise<McpAuthorizationRequest[]> {
      return read("mcp-authorizations");
    },
    async startMcpAuthorization(
      authRequestId: string,
    ): Promise<
      {status: "redirect"; authorizationUrl: string} | {status: "completed"}
    > {
      return write("start-mcp-authorization", {authRequestId});
    },
    async completeMcpBearerAuthorization(
      authRequestId: string,
      accessToken: string,
    ): Promise<boolean> {
      return write("complete-mcp-bearer-authorization", {
        authRequestId,
        accessToken,
      });
    },
    async approvals(): Promise<ApprovalRequest[]> {
      return read("approvals");
    },
    async resolveApproval(resolution: ApprovalResolution): Promise<boolean> {
      return write("resolve-approval", resolution);
    },
    async schedules(): Promise<ScheduledMessage[]> {
      return read("schedules");
    },
    async scheduleMessage(
      schedule: ScheduleSpecInput,
    ): Promise<ScheduleMutationResult> {
      return write("schedule", schedule);
    },
    async cancelSchedule(
      scheduleId: string,
    ): Promise<ScheduleCancellationResult> {
      return write("cancel-schedule", {scheduleId});
    },
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
