// HTTP mini-client for the Agent protocol, talking to the Restate ingress.
//
// This file is the canonical external consumer of the protocol: one typed
// method per public handler plus the consumption patterns a client needs —
// the cursor + notification long-poll loop used to follow transcript updates.
//
// It wraps Restate's official ingress client with agent-specific operations
// and the cursor + notification protocol used to follow a conversation.
//
// @example
//   const agent = createAgentClient({
//     ingressUrl: "http://localhost:8080",
//     agentId: "demo",
//   });
//   await agent.ask("What is the weather in Berlin?");
//   for await (const {entry} of agent.follow()) {
//     if (entry.role === "assistant") console.log(entry.text);
//   }

import type {
  AgentDelivery,
  AgentNotificationSnapshot,
  AgentProfile,
  ApprovalRequest,
  ApprovalResolution,
  AskResult,
  Guardrail,
  HistoryPage,
  McpAuthorizationContext,
  McpAuthorizationRequest,
  McpOAuthFlow,
  McpOAuthState,
  McpServer,
  McpServerMutationResult,
  McpServerRemovalResult,
  ScheduleCancellationResult,
  ScheduledMessage,
  ScheduleMutationResult,
} from "@restate-agents/types";
import {
  AgentIngressDefinition,
  type AgentIngressHandlers,
  AgentNotificationsIngressDefinition,
  type AgentNotificationsIngressHandlers,
  AgentSchedulerIngressDefinition,
  type AgentSchedulerIngressHandlers,
  AgentSessionIngressDefinition,
  type AgentSessionIngressHandlers,
  DEFAULT_ASK,
} from "@restate-agents/types/targets";
import {
  connect,
  HttpCallError,
  type RetryPolicy,
  rpc,
  serde,
} from "@restatedev/restate-sdk-clients";

export type SequencedEntry = HistoryPage["entries"][number];
export type ScheduleWhenBusy = ScheduledMessage["whenBusy"];

// ScheduleSpec's wire schema defaults whenBusy, so callers may omit it.
export type ScheduleSpecInput = {
  scheduleId: string;
  message: string;
  delaySeconds: number;
  repeatEverySeconds: number | null;
  whenBusy?: ScheduleWhenBusy;
};

export type FollowOptions = {
  /** Inclusive cursor to start from. Defaults to the beginning. */
  fromSequence?: number;
  /** Wait-window length per notification long-poll. */
  timeoutSeconds?: number;
  /** Stops the generator at the next checkpoint when aborted. */
  signal?: AbortSignal;
};

export type AgentClientOptions = {
  /** Restate ingress base URL, e.g. `http://localhost:8080`. */
  ingressUrl: string;
  /** The Agent virtual-object key. */
  agentId: string;
  /** Headers attached to every Restate ingress request. */
  headers?: Record<string, string>;
  /** Retry policy for idempotent ingress calls. Enabled by default. */
  retry?: boolean | RetryPolicy;
};

/** Failed ingress calls carry the HTTP status and the ingress error text. */
export class AgentClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentClientError";
  }
}

export function createAgentClient({
  ingressUrl,
  agentId,
  headers,
  retry = true,
}: AgentClientOptions) {
  const ingress = connect({
    url: ingressUrl.replace(/\/+$/, ""),
    headers,
    retry,
  });
  const agent = ingress.objectClient<AgentIngressHandlers>(
    AgentIngressDefinition,
    agentId,
  );
  const session = ingress.objectClient<AgentSessionIngressHandlers>(
    AgentSessionIngressDefinition,
    agentId,
  );
  const notifications = ingress.objectClient<AgentNotificationsIngressHandlers>(
    AgentNotificationsIngressDefinition,
    agentId,
  );
  const scheduler = ingress.objectClient<AgentSchedulerIngressHandlers>(
    AgentSchedulerIngressDefinition,
    agentId,
  );

  async function invoke<T>(operation: PromiseLike<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      if (!(error instanceof HttpCallError)) {
        throw error;
      }
      let message = error.responseText || error.message;
      try {
        message =
          (JSON.parse(error.responseText) as {message?: string}).message ??
          message;
      } catch {
        // Keep the Restate response text when it is not JSON.
      }
      throw new AgentClientError(error.status, message);
    }
  }

  async function history(fromSequence = 1, limit = 100): Promise<HistoryPage> {
    return invoke(session.history({fromSequence, limit}));
  }

  async function watchNotifications(
    afterRevision: number,
    timeoutSeconds: number,
    options?: {idempotencyKey?: string; signal?: AbortSignal},
  ): Promise<AgentNotificationSnapshot> {
    return invoke(
      notifications.watch(
        {afterRevision, timeoutSeconds},
        rpc.opts(options ?? {}),
      ),
    );
  }

  return {
    // ---- conversation ----

    /** Starts a turn when the Agent is idle, queues for the next turn otherwise. */
    async ask(message?: string): Promise<AskResult> {
      return invoke(agent.ask({message: message ?? DEFAULT_ASK}));
    },

    /**
     * Redirects the active turn without cancelling running work.
     *
     * @returns false when no turn is listening (idle or already interrupting).
     */
    async steer(message: string): Promise<boolean> {
      return invoke(agent.steer(message));
    },

    /**
     * Gracefully stops the active turn. The optional replacement message is
     * queued and enters the transcript when the successor turn starts.
     */
    async interrupt(reason: string, message?: string): Promise<boolean> {
      return invoke(agent.interrupt({reason, ...(message ? {message} : {})}));
    },

    /** Routes source-attributed input through the Agent's busy-turn policy. */
    async deliver(delivery: AgentDelivery): Promise<void> {
      return invoke(agent.deliver(delivery));
    },

    history,
    watchNotifications,

    /** Returns the Agent's current notification watermarks. */
    async notifications(): Promise<AgentNotificationSnapshot> {
      return invoke(
        notifications.snapshot(
          rpc.opts<void, AgentNotificationSnapshot>({input: serde.empty}),
        ),
      );
    },

    /**
     * Yields transcript entries in sequence order, forever: drains the cursor,
     * then parks in one notification wait window per idempotency key and
     * repeats. A network-failed window retries under the same key, attaching
     * to the still-parked invocation instead of stacking a new one.
     */
    async *follow({
      fromSequence = 1,
      timeoutSeconds = 55,
      signal,
    }: FollowOptions = {}): AsyncGenerator<SequencedEntry, void, void> {
      let cursor = fromSequence;
      let revision = 0;
      let windowKey = crypto.randomUUID();
      while (!signal?.aborted) {
        try {
          const page = await history(cursor, 100);
          if (page.entries.length > 0) {
            cursor = page.nextSequence;
            yield* page.entries;
            continue;
          }
          const watched = await watchNotifications(revision, timeoutSeconds, {
            idempotencyKey: windowKey,
            signal,
          });
          revision = watched.revision;
          windowKey = crypto.randomUUID();
        } catch (error) {
          if (signal?.aborted) {
            return;
          }
          if (error instanceof AgentClientError) {
            throw error;
          }
          // Transient transport failure: back off and retry. The window key
          // is deliberately kept so the retry attaches rather than re-parks.
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    },

    // ---- profile ----

    async profile(): Promise<AgentProfile> {
      return invoke(
        agent.profile(rpc.opts<void, AgentProfile>({input: serde.empty})),
      );
    },

    /** Replaces the persistent instructions; null clears them. */
    async setInstructions(instructions: string | null): Promise<void> {
      return invoke(agent.setInstructions({instructions}));
    },

    /** Replaces the complete guardrail list; an empty list clears it. */
    async setGuardrails(guardrails: Guardrail[]): Promise<void> {
      return invoke(agent.setGuardrails({guardrails}));
    },

    /** Controls built-in web search for future turns; enabled by default. */
    async setWebSearchEnabled(enabled: boolean): Promise<void> {
      return invoke(agent.setWebSearchEnabled({enabled}));
    },

    /** Creates or replaces one MCP server in the Agent profile. */
    async upsertMcpServer(server: McpServer): Promise<McpServerMutationResult> {
      return invoke(agent.upsertMcpServer(server));
    },

    /** Removes one MCP server from the Agent profile. */
    async removeMcpServer(id: string): Promise<McpServerRemovalResult> {
      return invoke(agent.removeMcpServer({id}));
    },

    // ---- MCP authorization ----

    /** Returns pending MCP OAuth actions without exposing stored credentials. */
    async mcpAuthorizations(): Promise<McpAuthorizationRequest[]> {
      return invoke(
        agent.mcpAuthorizations(
          rpc.opts<void, McpAuthorizationRequest[]>({input: serde.empty}),
        ),
      );
    },

    /** Returns private OAuth state for use by a trusted server-side BFF. */
    async mcpAuthorizationContext(
      authRequestId: string,
    ): Promise<McpAuthorizationContext> {
      return invoke(agent.mcpAuthorizationContext({authRequestId}));
    },

    /** Persists the redirect-round-trip state prepared by the BFF. */
    async saveMcpAuthorizationFlow(
      authRequestId: string,
      flow: McpOAuthFlow,
    ): Promise<boolean> {
      return invoke(agent.saveMcpAuthorizationFlow({authRequestId, flow}));
    },

    /** Stores private OAuth state and resumes the waiting Turn. */
    async completeMcpAuthorization(
      authRequestId: string,
      oauthState: McpOAuthState,
    ): Promise<boolean> {
      return invoke(
        agent.completeMcpAuthorization({authRequestId, oauthState}),
      );
    },

    /** Stores a private bearer token and resumes the waiting Turn. */
    async completeMcpBearerAuthorization(
      authRequestId: string,
      accessToken: string,
    ): Promise<boolean> {
      return invoke(
        agent.completeMcpBearerAuthorization({authRequestId, accessToken}),
      );
    },

    // ---- human approvals ----

    async approvals(): Promise<ApprovalRequest[]> {
      return invoke(
        agent.approvals(
          rpc.opts<void, ApprovalRequest[]>({input: serde.empty}),
        ),
      );
    },

    /**
     * Delivers one human decision to the waiting tool or policy gate.
     *
     * @returns false when the request is unknown or its turn is no longer
     * eligible to receive the decision.
     */
    async resolveApproval(resolution: ApprovalResolution): Promise<boolean> {
      return invoke(agent.resolveApproval(resolution));
    },

    // ---- scheduled messages ----

    async schedules(): Promise<ScheduledMessage[]> {
      return invoke(
        scheduler.list(
          rpc.opts<void, ScheduledMessage[]>({input: serde.empty}),
        ),
      );
    },

    /** Creates or replaces one schedule through the administrative path. */
    async scheduleMessage(
      schedule: ScheduleSpecInput,
    ): Promise<ScheduleMutationResult> {
      return invoke(
        scheduler.upsert({...schedule, whenBusy: schedule.whenBusy ?? "queue"}),
      );
    },

    async cancelSchedule(
      scheduleId: string,
    ): Promise<ScheduleCancellationResult> {
      return invoke(scheduler.cancel({scheduleId}));
    },
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
