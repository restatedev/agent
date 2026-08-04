// HTTP mini-client for the Agent protocol, talking to the Restate ingress.
//
// This file is the canonical external consumer of the protocol: one typed
// method per public handler plus the consumption patterns a client needs —
// the cursor + notification long-poll loop used to follow transcript updates.
//
// It imports types only, so it compiles to dependency-free JS that runs
// anywhere `fetch` and `crypto.randomUUID` exist (Node 18+, browsers), while
// staying build-checked against the public wire contracts: a
// protocol change breaks this file at compile time, not a client at runtime.
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
  AgentNotificationSnapshot,
  AgentProfile,
  ApprovalRequest,
  ApprovalResolution,
  AskResult,
  Guardrail,
  HistoryPage,
  ScheduleCancellationResult,
  ScheduledMessage,
  ScheduleMutationResult,
} from "@restate-agents/types";

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
  /** Override for test doubles; defaults to the global fetch. */
  fetch?: typeof fetch;
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
  fetch: fetchImpl = fetch,
}: AgentClientOptions) {
  const ingress = ingressUrl.replace(/\/+$/, "");
  const key = encodeURIComponent(agentId);
  const agentBase = `${ingress}/Agent/${key}`;
  const sessionBase = `${ingress}/AgentSession/${key}`;

  // One POST per handler. An `undefined` body means a void-input handler:
  // the ingress requires those requests to carry no body and no content-type.
  // An idempotency key makes retries of the same logical request attach to
  // the already-running invocation instead of spawning a new one.
  async function invoke<T>(
    base: string,
    handler: string,
    body?: unknown,
    options?: {idempotencyKey?: string; signal?: AbortSignal},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    const init: RequestInit = {method: "POST", headers};
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (options?.idempotencyKey) {
      headers["idempotency-key"] = options.idempotencyKey;
    }
    if (options?.signal) {
      init.signal = options.signal;
    }
    const response = await fetchImpl(`${base}/${handler}`, init);
    const text = await response.text();
    if (!response.ok) {
      let message = text || response.statusText;
      try {
        message = (JSON.parse(text) as {message?: string}).message ?? message;
      } catch {
        // not JSON; keep the raw body
      }
      throw new AgentClientError(response.status, message);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function history(fromSequence = 1, limit = 100): Promise<HistoryPage> {
    return invoke(sessionBase, "history", {fromSequence, limit});
  }

  async function watchNotifications(
    afterRevision: number,
    timeoutSeconds: number,
    options?: {idempotencyKey?: string; signal?: AbortSignal},
  ): Promise<AgentNotificationSnapshot> {
    return invoke(
      agentBase,
      "watchNotifications",
      {afterRevision, timeoutSeconds},
      options,
    );
  }

  return {
    // ---- conversation ----

    /** Starts a turn when the Agent is idle, queues for the next turn otherwise. */
    async ask(message?: string): Promise<AskResult> {
      return invoke(agentBase, "ask", message === undefined ? {} : {message});
    },

    /**
     * Redirects the active turn without cancelling running work.
     *
     * @returns false when no turn is listening (idle or already interrupting).
     */
    async steer(message: string): Promise<boolean> {
      return invoke(agentBase, "steer", message);
    },

    /**
     * Gracefully stops the active turn. The optional replacement message is
     * queued and enters the transcript when the successor turn starts.
     */
    async interrupt(reason: string, message?: string): Promise<boolean> {
      return invoke(agentBase, "interrupt", {
        reason,
        ...(message ? {message} : {}),
      });
    },

    history,
    watchNotifications,

    /** Returns the Agent's current notification watermarks. */
    async notifications(): Promise<AgentNotificationSnapshot> {
      return invoke(agentBase, "notifications");
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
      return invoke(agentBase, "profile");
    },

    /** Replaces the persistent instructions; null clears them. */
    async setInstructions(instructions: string | null): Promise<void> {
      return invoke(agentBase, "setInstructions", {instructions});
    },

    /** Replaces the complete guardrail list; an empty list clears it. */
    async setGuardrails(guardrails: Guardrail[]): Promise<void> {
      return invoke(agentBase, "setGuardrails", {guardrails});
    },

    // ---- human approvals ----

    async approvals(): Promise<ApprovalRequest[]> {
      return invoke(agentBase, "approvals");
    },

    /**
     * Delivers one human decision to the waiting tool or policy gate.
     *
     * @returns false when the request is unknown or its turn is no longer
     * eligible to receive the decision.
     */
    async resolveApproval(resolution: ApprovalResolution): Promise<boolean> {
      return invoke(agentBase, "resolveApproval", resolution);
    },

    // ---- scheduled messages ----

    async schedules(): Promise<ScheduledMessage[]> {
      return invoke(agentBase, "schedules");
    },

    /** Creates or replaces one schedule through the administrative path. */
    async scheduleMessage(
      schedule: ScheduleSpecInput,
    ): Promise<ScheduleMutationResult> {
      return invoke(agentBase, "scheduleMessage", {turnId: null, schedule});
    },

    async cancelSchedule(
      scheduleId: string,
    ): Promise<ScheduleCancellationResult> {
      return invoke(agentBase, "cancelSchedule", {turnId: null, scheduleId});
    },
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
