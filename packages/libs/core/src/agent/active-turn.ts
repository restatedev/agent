// The Agent's active turn: the `turn` and `pending` state keys, plus the
// AgentSession.doTurn invocation and its interrupt and steering signals.
// It knows nothing about conversation history, which AgentSession owns.

import type {AgentTools, ConversationEntry} from "@restate-agents/types";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

import {
  AGENT_SESSION_SIGNALS,
  type AgentSessionSteering,
  type AgentTurnOutcome,
  type AgentTurnRequest,
} from "../internal-types.js";
import {AgentSession} from "../session/index.js";
import {listState, objectKey} from "../state.js";

type ActiveTurn = {
  /** AgentSession.doTurn invocation ID and signal target. */
  id: string;
  tools: AgentTools;
  /** The accepted interruption while its terminal outcome is still pending. */
  interruptReason?: string;
  /** Steering signals sent to this turn in FIFO order. */
  steeringBatches: AgentSessionSteering[];
  /**
   * `source/sourceId` of every external delivery this turn opened with or
   * was steered by. A coalescing producer (a recurring schedule) is skipped
   * while its previous delivery is still being worked on.
   */
  deliveries?: string[];
};

/** Entries waiting for the next turn, in FIFO order. */
const pending = listState<ConversationEntry>("pending");

/**
 * Bounds input a busy agent holds: queued user messages, and steering
 * batches sent to one turn. The whole list is rewritten on every change, so
 * an unbounded producer would make each write, and the next turn's opening
 * context, grow without limit.
 */
const MAX_QUEUED_MESSAGES = 32;
const MAX_STEERING_BATCHES = 32;

const tooManyRequests = (message: string) =>
  new TerminalError(message, {errorCode: 429});

export function* current(): restate.Operation<ActiveTurn | undefined> {
  return (yield* restate.state().get<ActiveTurn>("turn")) ?? undefined;
}

/** Whether `turnId` is the active turn and is not being interrupted. */
export function* accepting(turnId: string): restate.Operation<boolean> {
  const active = yield* current();
  return active?.id === turnId && active.interruptReason === undefined;
}

/**
 * Starts an AgentSession invocation and records it as the active turn.
 * The caller ensures no turn is active.
 *
 * @returns The new invocation ID, which is also the turn ID.
 */
export function* start(request: AgentTurnRequest): restate.Operation<string> {
  const started = yield* restate
    .sendClient(AgentSession, objectKey())
    .doTurn(request);
  restate.state().set("turn", {
    id: started.id,
    tools: request.tools,
    steeringBatches: [],
    deliveries: deliveryKeys(request.entries),
  } satisfies ActiveTurn);
  return started.id;
}

/**
 * Adds entries to the next turn's queue.
 *
 * @returns The number of queued user messages.
 * @throws 429 when the queue already holds its limit of user messages.
 */
export function* enqueue(
  ...entries: ConversationEntry[]
): restate.Operation<number> {
  const queued = [...(yield* pending.get()), ...entries];
  const messages = userMessages(queued);
  if (messages > MAX_QUEUED_MESSAGES) {
    throw tooManyRequests(
      `The agent is busy and already holds ${MAX_QUEUED_MESSAGES} queued messages`,
    );
  }
  pending.set(queued);
  return messages;
}

/**
 * Puts entries a successor turn could not start with back on the queue. They
 * were already accepted once, so the limit does not apply.
 */
export function* requeue(
  ...entries: ConversationEntry[]
): restate.Operation<void> {
  yield* pending.update((items) => [...items, ...entries]);
}

/** Removes and returns every queued entry. */
export function* drainPending(): restate.Operation<ConversationEntry[]> {
  const entries = yield* pending.get();
  pending.clear();
  return entries;
}

/** Drops the queue of a retired agent. */
export function clearPending(): void {
  pending.clear();
}

/**
 * Whether a delivery from this producer is already queued for the next turn
 * or part of the active one.
 */
export function* hasDelivery(
  source: string,
  sourceId: string,
): restate.Operation<boolean> {
  const key = deliveryKey(source, sourceId);
  if ((yield* current())?.deliveries?.includes(key)) return true;
  return deliveryKeys(yield* pending.get()).includes(key);
}

/**
 * Signals the active turn to interrupt and marks it as winding down.
 *
 * @returns Whether this call sent the interrupt: `false` when no turn is
 * active or one was already sent.
 */
export function* interrupt(reason: string): restate.Operation<boolean> {
  const active = yield* current();
  if (!active || active.interruptReason !== undefined) return false;
  restate
    .invocation(active.id)
    .signal<string>(AGENT_SESSION_SIGNALS.interrupt)
    .resolve(reason);
  restate.state().set("turn", {...active, interruptReason: reason});
  return true;
}

/**
 * Sends the queued entries, `extra` entries and a new instruction to the
 * active turn as one steering batch.
 *
 * @returns Whether an active, non-interrupting turn received it. The queue is
 * left untouched otherwise.
 */
export function* steer(
  message: string,
  ...extra: ConversationEntry[]
): restate.Operation<boolean> {
  const active = yield* current();
  if (!active || active.interruptReason !== undefined) return false;
  if (active.steeringBatches.length >= MAX_STEERING_BATCHES) {
    throw tooManyRequests(
      `The active turn already received ${MAX_STEERING_BATCHES} steering messages`,
    );
  }
  const steering = {queued: [...(yield* drainPending()), ...extra], message};
  restate.state().set("turn", {
    ...active,
    steeringBatches: [...active.steeringBatches, steering],
    deliveries: [
      ...(active.deliveries ?? []),
      ...deliveryKeys(steering.queued),
    ],
  });
  restate
    .invocation(active.id)
    .signal<AgentSessionSteering>(AGENT_SESSION_SIGNALS.steering)
    .resolve(steering);
  return true;
}

/**
 * Retires the active turn when `outcome` belongs to it.
 *
 * A late accepted interruption overrides the reported status, and steering
 * the turn never consumed is recovered ahead of the queue.
 *
 * @returns The reconciled outcome and the entries that must open the next
 * turn, or `undefined` for a stale or duplicate outcome.
 */
export function* finish(outcome: AgentTurnOutcome): restate.Operation<
  | {
      outcome: AgentTurnOutcome;
      queuedEntries: ConversationEntry[];
    }
  | undefined
> {
  const active = yield* current();
  if (active?.id !== outcome.turnId) return undefined;
  restate.state().clear("turn");

  const missedSteering = active.steeringBatches
    .slice(outcome.consumedSteering)
    .flatMap(({queued, message}): ConversationEntry[] => [
      ...queued,
      {role: "user", text: message, delivery: "queued"},
    ]);
  // A failure keeps its error; any other ending becomes the interruption
  // the user asked for.
  const interrupted =
    active.interruptReason !== undefined &&
    (outcome.status === "completed" || outcome.status === "stopped");
  return {
    outcome: interrupted
      ? {
          turnId: outcome.turnId,
          status: "interrupted",
          reason: active.interruptReason!,
          response: outcome.response,
          consumedSteering: outcome.consumedSteering,
        }
      : outcome,
    queuedEntries: [...missedSteering, ...(yield* drainPending())],
  };
}

function userMessages(entries: ConversationEntry[]): number {
  return entries.filter(({role}) => role === "user").length;
}

function deliveryKey(source: string, sourceId: string): string {
  return JSON.stringify([source, sourceId]);
}

function deliveryKeys(entries: ConversationEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.role === "event" && entry.type === "delivery" && entry.sourceId
      ? [deliveryKey(entry.source, entry.sourceId)]
      : [],
  );
}
