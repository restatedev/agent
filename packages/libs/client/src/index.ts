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
  ScheduleCancellationResult,
  ScheduledMessage,
  ScheduleMutationResult,
  ScheduleSpec,
  ToolCatalog,
} from "@restate-agents/types";

export {HttpCallError as IngressClientError} from "@restatedev/restate-sdk-clients";

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

/** Options for one notification long-poll window. */
export type WatchOptions = {
  /** Reusing a key after a network failure attaches to the parked wait. */
  idempotencyKey?: string;
  signal?: AbortSignal;
};

/**
 * Typed operations on one agent through Restate ingress.
 *
 * Every method maps to one public handler of `Agent`, `AgentSession`,
 * `AgentNotifications` or `AgentScheduler` for this client's agent ID, except
 * `follow`, which combines `history` and `watchNotifications` into a stream.
 * Rejected calls throw {@link AgentClientError}.
 */
export interface AgentClient {
  // ---- conversation ----

  /** Starts a turn when the agent is idle, or queues the message for the next turn. */
  ask(message?: string): Promise<AskResult>;

  /**
   * Redirects the active turn without cancelling running work.
   *
   * @returns false when no turn is listening (idle or already interrupting).
   */
  steer(message: string): Promise<boolean>;

  /**
   * Gracefully stops the active turn. The optional replacement message is
   * queued and enters the transcript when the successor turn starts.
   *
   * @returns whether an interruption or replacement was accepted.
   */
  interrupt(reason: string, message?: string): Promise<boolean>;

  /** Routes source-attributed input through the agent's busy-turn policy. */
  deliver(delivery: AgentDelivery): Promise<void>;

  /** Reads up to `limit` transcript entries starting at `fromSequence` (inclusive). */
  history(fromSequence?: number, limit?: number): Promise<HistoryPage>;

  /** Returns the agent's current notification watermarks. */
  notifications(): Promise<AgentNotificationSnapshot>;

  /**
   * Waits up to `timeoutSeconds` for a notification revision newer than
   * `afterRevision`, then returns the current watermarks.
   */
  watchNotifications(
    afterRevision: number,
    timeoutSeconds: number,
    options?: WatchOptions,
  ): Promise<AgentNotificationSnapshot>;

  /**
   * Yields transcript entries in sequence order until `signal` aborts,
   * waiting for notifications whenever the cursor is caught up.
   */
  follow(options?: FollowOptions): AsyncGenerator<SequencedEntry, void, void>;

  // ---- profile ----

  /** Instructions, guardrails, memories and tool grants the next turn will snapshot. */
  profile(): Promise<AgentProfile>;

  /** Replaces the persistent instructions; null clears them. */
  setInstructions(instructions: string | null): Promise<void>;

  /** Replaces the complete guardrail list; an empty list clears it. */
  setGuardrails(guardrails: Guardrail[]): Promise<void>;

  /** Controls built-in web search for future turns; enabled by default. */
  setWebSearchEnabled(enabled: boolean): Promise<void>;

  /** Replaces the agent's tool grants for future turns. */
  setTools(tools: AgentTools): Promise<void>;

  /** Deletes one memory. @returns whether it existed. */
  deleteMemory(key: string): Promise<boolean>;

  /** Every tool this agent could be granted. */
  toolCatalog(): Promise<ToolCatalog>;

  // ---- lifecycle and children ----

  /** The agent's display name and, for a child, its parent. */
  metadata(): Promise<AgentMetadata>;

  /** The agent's direct children. */
  children(): Promise<ChildAgent[]>;

  /**
   * Retires a top-level agent: stops its work, retires its children,
   * schedules and sandbox, and refuses new turns. Idempotent.
   */
  retire(): Promise<void>;

  // ---- schedules ----

  /** The agent's active schedules. */
  schedules(): Promise<ScheduledMessage[]>;

  /** Creates or replaces the schedule named by `spec.scheduleId`. */
  schedule(spec: ScheduleSpec): Promise<ScheduleMutationResult>;

  /** Cancels one schedule. Idempotent. */
  cancelSchedule(scheduleId: string): Promise<ScheduleCancellationResult>;

  // ---- human approvals ----

  /** Every approval request currently awaiting a decision. */
  approvals(): Promise<ApprovalRequest[]>;

  /**
   * Delivers one human decision to the waiting tool or policy gate.
   *
   * @returns false when the request is unknown or its turn is no longer
   * eligible to receive the decision.
   */
  resolveApproval(resolution: ApprovalResolution): Promise<boolean>;
}

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
}: AgentClientOptions): AgentClient {
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
    options?: WatchOptions,
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

    async ask(message?: string): Promise<AskResult> {
      return invoke(agent.ask({message: message ?? DEFAULT_ASK}));
    },

    async steer(message: string): Promise<boolean> {
      return invoke(agent.steer(message));
    },

    async interrupt(reason: string, message?: string): Promise<boolean> {
      return invoke(agent.interrupt({reason, ...(message ? {message} : {})}));
    },

    async deliver(delivery: AgentDelivery): Promise<void> {
      return invoke(agent.deliver(delivery));
    },

    history,
    watchNotifications,

    async notifications(): Promise<AgentNotificationSnapshot> {
      return invoke(
        notifications.snapshot(
          rpc.opts<void, AgentNotificationSnapshot>({input: serde.empty}),
        ),
      );
    },

    // Drains the cursor, then parks in one notification wait window per
    // idempotency key and repeats. A network-failed window retries under the
    // same key, attaching to the still-parked invocation instead of stacking
    // a new one.
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

    async setInstructions(instructions: string | null): Promise<void> {
      return invoke(agent.setInstructions({instructions}));
    },

    async setGuardrails(guardrails: Guardrail[]): Promise<void> {
      return invoke(agent.setGuardrails({guardrails}));
    },

    async setWebSearchEnabled(enabled: boolean): Promise<void> {
      return invoke(agent.setWebSearchEnabled({enabled}));
    },

    async setTools(tools: AgentTools): Promise<void> {
      return invoke(agent.setTools(tools));
    },
    async metadata() {
      return invoke(agent.metadata(rpc.opts({input: serde.empty})));
    },
    async children() {
      return invoke(agent.children(rpc.opts({input: serde.empty})));
    },
    async retire() {
      return invoke(agent.retire({}));
    },
    async deleteMemory(key: string) {
      return invoke(agent.deleteMemory({key}));
    },
    async schedules() {
      return invoke(scheduler.list(rpc.opts({input: serde.empty})));
    },
    async schedule(spec: ScheduleSpec) {
      return invoke(scheduler.upsert(spec));
    },
    async cancelSchedule(scheduleId: string) {
      return invoke(scheduler.cancel({scheduleId}));
    },
    async toolCatalog() {
      return invoke(agent.toolCatalog(rpc.opts({input: serde.empty})));
    },

    // ---- human approvals ----

    async approvals(): Promise<ApprovalRequest[]> {
      return invoke(
        agent.approvals(
          rpc.opts<void, ApprovalRequest[]>({input: serde.empty}),
        ),
      );
    },

    async resolveApproval(resolution: ApprovalResolution): Promise<boolean> {
      return invoke(agent.resolveApproval(resolution));
    },
  };
}
