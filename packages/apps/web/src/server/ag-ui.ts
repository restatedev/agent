// Serves AG-UI runs from the agent's durable conversation. An AG-UI thread is
// one agent (`threadId` is the agent ID) and a run follows one turn.
//
// A run does not execute anything itself. It hands the new message to the
// agent, the way the conversation UI does, then reads the history the turn
// writes and translates each entry into AG-UI events until the turn ends.
// Because the turn runs in Restate and not in this request, closing the
// stream does not stop it: a later run or reconnect picks up from history.
//
// Four kinds of input, told apart by what the run carries:
// - `resume`: answers the approvals a previous run stopped on.
// - a new user message (the last message, with an ID this adapter did not
//   mint): asks, or steers or interrupts the active turn when
//   `forwardedProps.mode` says so.
// - anything else: a connect. The run sends the whole conversation as a
//   MESSAGES_SNAPSHOT and follows the active turn, if there is one.
//
// A guardrail or tool that needs a person suspends the turn on a durable
// signal. The run ends there with an interrupt outcome, and the turn waits,
// holding no process, until a run resumes it.
import {
  contentToText,
  type Event,
  EventType,
  type Interrupt,
  type Message,
  type RunAgentInput,
} from "@ag-ui/core";
import {RunAgentInputSchema} from "@ag-ui/core/schemas";
import {AgentClientError, type AgentClient} from "@restate-agents/client";
import {
  type ApprovalDecision,
  ApprovalDecisionSchema,
  type ApprovalRequest,
} from "@restate-agents/types";

import {
  entryEvents,
  historyMessages,
  historySequence,
  type SequencedEntry,
} from "./ag-ui-events";
import {UiRequestError} from "./request-guard";

export type AgUiClient = Pick<
  AgentClient,
  | "ask"
  | "steer"
  | "interrupt"
  | "history"
  | "follow"
  | "approvals"
  | "resolveApproval"
>;

/** How a new user message reaches a busy agent. */
type Mode = "ask" | "steer" | "interrupt";

/**
 * The turn a run follows. A queued message runs in the turn after the one
 * that is active now, and a steer or interrupt lands in the active turn,
 * whose ID the run learns from the first entry it reads.
 */
type Target =
  | {kind: "turn"; turnId: string}
  | {kind: "after"; turnId: string}
  | {kind: "active"}
  | {kind: "none"};

/** Where a run starts reading history, and what it is waiting for. */
type Plan = {
  cursor: number;
  target: Target;
  /** The user message this run delivered; the client already shows it. */
  delivered?: string;
  /** Events to send before following history. */
  preamble: Event[];
};

/** Why a run cannot go ahead; it ends with a RUN_ERROR carrying the code. */
class RunRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Validates a request body as a RunAgentInput. */
export function parseRunInput(body: unknown): RunAgentInput {
  const parsed = RunAgentInputSchema.safeParse(body);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message;
    throw new UiRequestError(400, `Invalid RunAgentInput: ${reason}`);
  }
  return parsed.data;
}

/**
 * One run as server-sent events, one `data:` line per event, the way
 * AG-UI's HTTP transport reads them.
 */
export function runResponse(
  client: AgUiClient,
  input: RunAgentInput,
  signal: AbortSignal,
): Response {
  const events = runEvents(client, input, signal);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next();
      if (next.done) {
        controller.close();
        return;
      }
      const line = `data: ${JSON.stringify(next.value)}\n\n`;
      controller.enqueue(encoder.encode(line));
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "private, no-store",
    },
  });
}

/**
 * The AG-UI events of one run: RUN_STARTED, the events of every history
 * entry the run reads, and RUN_FINISHED or RUN_ERROR. Aborting `signal`
 * ends the stream without touching the turn.
 */
export async function* runEvents(
  client: AgUiClient,
  input: RunAgentInput,
  signal: AbortSignal,
): AsyncGenerator<Event, void, void> {
  const {threadId, runId} = input;
  yield {type: EventType.RUN_STARTED, threadId, runId};
  try {
    const plan = await planRun(client, input);
    yield* plan.preamble;
    if (plan.target.kind === "none") {
      yield {type: EventType.RUN_FINISHED, threadId, runId};
      return;
    }
    // A resume or a reconnect can find the turn already waiting for a person.
    if (plan.target.kind === "turn") {
      const interrupts = await pendingInterrupts(client, plan.target.turnId);
      if (interrupts.length > 0) {
        yield interrupted(input, interrupts);
        return;
      }
    }
    yield* followTurn(client, input, plan, signal);
  } catch (error) {
    if (signal.aborted) {
      return;
    }
    yield runError(error);
  }
}

async function* followTurn(
  client: AgUiClient,
  input: RunAgentInput,
  plan: Plan,
  signal: AbortSignal,
): AsyncGenerator<Event, void, void> {
  let target = plan.target;
  let delivered = plan.delivered;
  const entries = client.follow({fromSequence: plan.cursor, signal});
  for await (const sequenced of entries) {
    const {entry} = sequenced;
    target = narrowTarget(target, entry);
    if (entry.role === "user" && entry.text === delivered) {
      delivered = undefined;
      continue;
    }
    yield* entryEvents(sequenced);

    if (target.kind !== "turn" || !isOfTurn(entry, target.turnId)) {
      continue;
    }
    if (entry.role === "assistant") {
      yield turnEnded(input, entry);
      return;
    }
    if (entry.role === "event" && entry.type === "approval_request") {
      const interrupts = await pendingInterrupts(client, target.turnId);
      // Empty when someone already answered it elsewhere; keep following.
      if (interrupts.length > 0) {
        yield interrupted(input, interrupts);
        return;
      }
    }
  }
  // `follow` returns only once the signal aborts: the client is gone, and
  // there is no one left to send the end of the run to.
}

async function planRun(
  client: AgUiClient,
  input: RunAgentInput,
): Promise<Plan> {
  if (input.resume && input.resume.length > 0) {
    return resume(client, input);
  }
  const message = newUserMessage(input.messages);
  if (message === undefined) {
    return connect(client);
  }
  return deliver(client, input, message);
}

/**
 * Hands the message to the agent. The cursor is read first, so the run sees
 * every entry the delivery causes.
 */
async function deliver(
  client: AgUiClient,
  input: RunAgentInput,
  message: string,
): Promise<Plan> {
  const cursor = await tail(client, input.messages);
  const mode = requestedMode(input.forwardedProps);

  if (mode === "steer") {
    const accepted = await client.steer(message);
    if (accepted) {
      return {
        cursor,
        target: {kind: "active"},
        delivered: message,
        preamble: [],
      };
    }
    // Nothing is running to steer: the message starts a turn instead.
  }

  if (mode === "interrupt") {
    // The message is the reason; the turn ends with a summary that answers it.
    const accepted = await client.interrupt(message);
    if (!accepted) {
      throw new RunRejected("not_running", "No turn is running to interrupt");
    }
    return {cursor, target: {kind: "active"}, preamble: []};
  }

  const asked = await client.ask(message);
  if (asked.decision === "start") {
    return {
      cursor,
      target: {kind: "turn", turnId: asked.turnId},
      delivered: message,
      preamble: [],
    };
  }
  return {
    cursor,
    target: {kind: "after", turnId: asked.activeTurnId},
    delivered: message,
    preamble: [],
  };
}

/**
 * Delivers the decisions a previous run's interrupts asked for. Each
 * interrupt is a pending approval, and each must still be pending: an
 * approval that was answered elsewhere, or whose turn has ended, cannot be
 * answered again.
 */
async function resume(client: AgUiClient, input: RunAgentInput): Promise<Plan> {
  const cursor = await tail(client, input.messages);
  const pending = new Map(
    (await client.approvals()).map((approval) => [
      approval.approvalId,
      approval,
    ]),
  );
  let turnId: string | undefined;
  for (const answer of input.resume ?? []) {
    const approval = pending.get(answer.interruptId);
    if (!approval) {
      throw new RunRejected(
        "unknown_interrupt",
        `Interrupt ${answer.interruptId} is not waiting for an answer`,
      );
    }
    const decision = approvalDecision(answer.status, answer.payload);
    const accepted = await client.resolveApproval({
      approvalId: approval.approvalId,
      ...decision,
    });
    if (!accepted) {
      throw new RunRejected(
        "unknown_interrupt",
        `Interrupt ${answer.interruptId} is no longer waiting for an answer`,
      );
    }
    turnId = approval.turnId;
  }
  if (turnId === undefined) {
    throw new RunRejected("unknown_interrupt", "Nothing to resume");
  }
  return {cursor, target: {kind: "turn", turnId}, preamble: []};
}

/**
 * Rebuilds the client's view from history and follows the turn that is
 * still running, if any.
 */
async function connect(client: AgUiClient): Promise<Plan> {
  const {entries, nextSequence} = await readFrom(client, 1);
  const snapshot: Event = {
    type: EventType.MESSAGES_SNAPSHOT,
    messages: historyMessages(entries),
  };
  const turnId = activeTurn(entries);
  if (turnId === undefined) {
    return {cursor: nextSequence, target: {kind: "none"}, preamble: [snapshot]};
  }
  return {
    cursor: nextSequence,
    target: {kind: "turn", turnId},
    preamble: [snapshot],
  };
}

/**
 * The text of the message this run delivers: the last message, when it is
 * from the user and did not come from history. A message this adapter sent
 * the client carries a history ID; sending it back is not a new request.
 */
function newUserMessage(messages: Message[]): string | undefined {
  const last = messages.at(-1);
  if (!last || last.role !== "user") {
    return undefined;
  }
  if (historySequence(last.id) !== undefined) {
    return undefined;
  }
  const text = contentToText(last.content).trim();
  if (!text) {
    throw new RunRejected("empty_message", "The user message has no text");
  }
  return text;
}

function requestedMode(forwardedProps: unknown): Mode {
  const mode = (forwardedProps as {mode?: unknown} | undefined)?.mode;
  if (mode === undefined || mode === "ask") {
    return "ask";
  }
  if (mode === "steer" || mode === "interrupt") {
    return mode;
  }
  throw new RunRejected(
    "invalid_mode",
    "forwardedProps.mode must be ask, steer or interrupt",
  );
}

/**
 * Resolves a target that waits for a turn ID once an entry names one.
 * Turns run one at a time, so the first turn seen is the active one, and the
 * first other turn seen after a known one is its successor.
 */
function narrowTarget(target: Target, entry: SequencedEntry["entry"]): Target {
  const turnId = entryTurnId(entry);
  if (turnId === undefined) {
    return target;
  }
  if (target.kind === "active") {
    return {kind: "turn", turnId};
  }
  if (target.kind === "after" && target.turnId !== turnId) {
    return {kind: "turn", turnId};
  }
  return target;
}

function entryTurnId(entry: SequencedEntry["entry"]): string | undefined {
  if (entry.role === "user") {
    return undefined;
  }
  if ("turnId" in entry) {
    return entry.turnId;
  }
  return undefined;
}

function isOfTurn(entry: SequencedEntry["entry"], turnId: string): boolean {
  return entryTurnId(entry) === turnId;
}

/** The turn that has written entries but no answer yet. */
function activeTurn(entries: SequencedEntry[]): string | undefined {
  let active: string | undefined;
  for (const {entry} of entries) {
    if (entry.role === "assistant") {
      active = undefined;
      continue;
    }
    const turnId = entryTurnId(entry);
    if (turnId !== undefined) {
      active = turnId;
    }
  }
  return active;
}

async function pendingInterrupts(
  client: AgUiClient,
  turnId: string,
): Promise<Interrupt[]> {
  const approvals = await client.approvals();
  return approvals
    .filter((approval) => approval.turnId === turnId)
    .map(approvalInterrupt);
}

/** The answer an approval interrupt expects: the decision and a reason. */
const APPROVAL_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    decision: {type: "string", enum: ["approved", "rejected"]},
    reason: {type: "string"},
  },
  required: ["decision"],
};

function approvalInterrupt(approval: ApprovalRequest): Interrupt {
  return {
    id: approval.approvalId,
    reason: "confirmation",
    message: approval.question,
    responseSchema: APPROVAL_RESPONSE_SCHEMA,
    metadata: {
      turnId: approval.turnId,
      ...(approval.guardrailId ? {guardrailId: approval.guardrailId} : {}),
    },
  };
}

function approvalDecision(
  status: "resolved" | "cancelled",
  payload: unknown,
): ApprovalDecision {
  if (status === "cancelled") {
    return {decision: "rejected", reason: "The user cancelled the request"};
  }
  const parsed = ApprovalDecisionSchema.safeParse(payload);
  if (!parsed.success) {
    throw new RunRejected(
      "invalid_answer",
      'An approval answer is {"decision": "approved" | "rejected", "reason"?: string}',
    );
  }
  return parsed.data;
}

/**
 * The next history sequence. Messages this adapter sent carry their
 * sequence in their ID, so reading starts at the newest one the client has
 * rather than at the beginning of a long conversation.
 */
async function tail(client: AgUiClient, messages: Message[]): Promise<number> {
  const known = messages
    .map((message) => historySequence(message.id))
    .filter((sequence) => sequence !== undefined);
  const newest = Math.max(0, ...known);
  if (newest > 0 && (await exists(client, newest))) {
    return (await readFrom(client, newest)).nextSequence;
  }
  return (await readFrom(client, 1)).nextSequence;
}

async function exists(client: AgUiClient, sequence: number): Promise<boolean> {
  const page = await client.history(sequence, 1);
  return page.entries[0]?.sequence === sequence;
}

async function readFrom(
  client: AgUiClient,
  fromSequence: number,
): Promise<{entries: SequencedEntry[]; nextSequence: number}> {
  const entries: SequencedEntry[] = [];
  let nextSequence = fromSequence;
  while (true) {
    const page = await client.history(nextSequence, 100);
    entries.push(...page.entries);
    if (page.entries.length > 0 && page.nextSequence <= nextSequence) {
      throw new Error("History cursor did not advance");
    }
    nextSequence = page.nextSequence;
    if (page.entries.length < 100) {
      return {entries, nextSequence};
    }
  }
}

function turnEnded(
  input: RunAgentInput,
  entry: Extract<SequencedEntry["entry"], {role: "assistant"}>,
): Event {
  if (entry.status === "failed") {
    return {
      type: EventType.RUN_ERROR,
      message: entry.text || "The turn failed",
      code: "turn_failed",
    };
  }
  return {
    type: EventType.RUN_FINISHED,
    threadId: input.threadId,
    runId: input.runId,
    outcome: {type: "success"},
    result: {turnId: entry.turnId, status: entry.status},
  };
}

function interrupted(input: RunAgentInput, interrupts: Interrupt[]): Event {
  return {
    type: EventType.RUN_FINISHED,
    threadId: input.threadId,
    runId: input.runId,
    outcome: {type: "interrupt", interrupts},
  };
}

function runError(error: unknown): Event {
  if (error instanceof RunRejected) {
    return {
      type: EventType.RUN_ERROR,
      message: error.message,
      code: error.code,
    };
  }
  if (error instanceof AgentClientError) {
    return {
      type: EventType.RUN_ERROR,
      message: error.message,
      code: `http_${error.status}`,
    };
  }
  // Unknown errors may carry request headers or token material.
  console.error("Unexpected AG-UI run failure");
  return {type: EventType.RUN_ERROR, message: "Unexpected agent error"};
}
