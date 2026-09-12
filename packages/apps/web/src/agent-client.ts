import type {
  AgentNotificationSnapshot,
  AgentProfile,
  AgentTools,
  ApprovalRequest,
  ApprovalResolution,
  AskResult,
  Guardrail,
  HistoryPage,
  McpAuthorizationRequest,
  ToolDescriptor,
} from "@restate-agents/types";

export type SequencedEntry = HistoryPage["entries"][number];
export type AgentSnapshot = {
  notification: AgentNotificationSnapshot;
  profile: AgentProfile;
  approvals: ApprovalRequest[];
  mcpAuthorizations: McpAuthorizationRequest[];
  history: HistoryPage;
};
export type AgentSnapshotUpdate = Pick<AgentSnapshot, "notification"> &
  Partial<Omit<AgentSnapshot, "notification">>;
type RequestOptions = {
  headers?: Record<string, string>;
  onResponse?: (response: Response) => void;
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

export async function request<T>(path: string, options: RequestOptions = {}) {
  const response = await fetch(path, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      ...options.headers,
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
  options.onResponse?.(response);
  return result as T;
}

export function createAgentClient(
  agentId: string,
  workspace?: {userId: string; authorization: () => string | undefined},
) {
  // Private to this client/workspace instance, never persisted or shared across accounts.
  let accessToken: string | undefined;
  const send = <T>(path: string, options: RequestOptions = {}) => {
    const proof = workspace?.authorization();
    return request<T>(path, {
      ...options,
      headers: {
        ...(accessToken ? {"x-agent-access": accessToken} : {}),
        // Large directories use the small per-agent proof to stay within proxy header limits.
        ...(proof && proof.length <= 6000 ? {"x-workspace-access": proof} : {}),
      },
      onResponse(response) {
        if (
          workspace &&
          response.headers.get("x-agent-user") !== workspace.userId
        )
          throw new AgentClientError(401, "Session changed");
        accessToken = response.headers.get("x-agent-access") ?? accessToken;
      },
    });
  };
  const base = `/api/agent/${encodeURIComponent(agentId)}`;
  const read = <T>(operation: string, parameters?: URLSearchParams) =>
    send<T>(`${base}/${operation}${parameters ? `?${parameters}` : ""}`);
  const write = <T>(operation: string, body: unknown) =>
    send<T>(`${base}/${operation}`, {body});

  return {
    async snapshot(options?: {signal?: AbortSignal}): Promise<AgentSnapshot> {
      return send(`${base}/snapshot`, options);
    },
    async sync(
      since: AgentNotificationSnapshot,
      fromSequence: number,
      options?: {idempotencyKey?: string; signal?: AbortSignal},
    ): Promise<AgentSnapshotUpdate> {
      return send(
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
      return send(
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
    async setTools(tools: AgentTools): Promise<void> {
      await write("tools", tools);
    },
    async toolCatalog(): Promise<{
      builtin: ToolDescriptor[];
      dynamic: ToolDescriptor[];
    }> {
      return read("tool-catalog");
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
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
