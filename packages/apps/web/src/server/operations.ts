// The browser-facing operations of the UI proxy, one table for reads (GET)
// and one for mutations (POST). Names match the core Agent handlers. The
// browser client derives its method types from these tables with type-only
// imports, so the contract is written once and zod never reaches the bundle.
import "server-only";
import type {AgentClient} from "@restate-agents/client";
import {
  type AgentNotificationSnapshot,
  AgentNotificationSnapshotSchema,
  ApprovalResolutionSchema,
  AskRequestSchema,
  InterruptRequestSchema,
  MemoryKeyRequestSchema,
  ProfileUpdateSchema,
  ScheduleIdRequestSchema,
  SteerRequestSchema,
} from "@restate-agents/types";

import {loadAgentSnapshot, syncAgentSnapshot} from "./agent-snapshot";
import {UiRequestError} from "./request-guard";

/** The part of a zod schema a mutation uses to validate its JSON body. */
type BodySchema<T> = {
  safeParse(
    value: unknown,
  ):
    | {success: true; data: T}
    | {success: false; error: {issues: {message: string}[]}};
};

/**
 * One mutation: `run` keeps the typed body and result for the browser
 * client, `execute` validates an untyped body first. Every `execute` has the
 * same signature, so the route can call whichever one it looks up.
 */
function mutation<T, R>(
  schema: BodySchema<T>,
  run: (client: AgentClient, body: T) => Promise<R>,
) {
  return {
    run,
    async execute(client: AgentClient, body: unknown): Promise<R> {
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        const reason = parsed.error.issues[0]?.message;
        throw new UiRequestError(400, `Invalid request body: ${reason}`);
      }
      return run(client, parsed.data);
    },
  };
}

export const MUTATIONS = {
  ask: mutation(AskRequestSchema, (client, {message}) => client.ask(message)),
  steer: mutation(SteerRequestSchema, (client, {message}) =>
    client.steer(message),
  ),
  interrupt: mutation(InterruptRequestSchema, (client, {reason, message}) =>
    client.interrupt(reason, message),
  ),
  updateProfile: mutation(ProfileUpdateSchema, (client, update) =>
    client.updateProfile(update),
  ),
  deleteMemory: mutation(MemoryKeyRequestSchema, (client, {key}) =>
    client.deleteMemory(key),
  ),
  cancelSchedule: mutation(ScheduleIdRequestSchema, (client, {scheduleId}) =>
    client.cancelSchedule(scheduleId),
  ),
  resolveApproval: mutation(ApprovalResolutionSchema, (client, resolution) =>
    client.resolveApproval(resolution),
  ),
};

type Read = (client: AgentClient, request: Request) => Promise<unknown>;

export const READS = {
  /** Everything the conversation view renders. */
  snapshot: (client, request) => loadAgentSnapshot(client, request.signal),
  /** Waits for a newer notification, then returns what changed. */
  sync,
  profile: (client) => client.profile(),
  toolCatalog: (client) => client.toolCatalog(),
} satisfies Record<string, Read>;

export type Mutations = typeof MUTATIONS;
export type Reads = typeof READS;
export type MutationBody<K extends keyof Mutations> = Parameters<
  Mutations[K]["run"]
>[1];
export type MutationResult<K extends keyof Mutations> = Awaited<
  ReturnType<Mutations[K]["run"]>
>;
export type ReadResult<K extends keyof Reads> = Awaited<ReturnType<Reads[K]>>;

/**
 * Whether a URL segment names an operation in `table`. `Object.hasOwn`
 * keeps inherited names such as `constructor` from matching.
 */
export function isOperation<T extends object>(
  table: T,
  operation: string,
): operation is Extract<keyof T, string> {
  return Object.hasOwn(table, operation);
}

async function sync(client: AgentClient, request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const since = parseCursor(searchParams.get("since"));
  const fromSequence = Number(searchParams.get("fromSequence") ?? 1);
  if (!Number.isSafeInteger(fromSequence) || fromSequence < 1) {
    throw new UiRequestError(400, "fromSequence must be a positive integer");
  }
  return syncAgentSnapshot(client, since, fromSequence, {
    signal: request.signal,
    idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
  });
}

function parseCursor(value: string | null): AgentNotificationSnapshot {
  try {
    return AgentNotificationSnapshotSchema.parse(JSON.parse(value ?? "null"));
  } catch {
    throw new UiRequestError(400, "Invalid notification cursor");
  }
}
