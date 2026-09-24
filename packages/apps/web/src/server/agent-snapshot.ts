import type {AgentClient} from "@restate-agents/client";

import type {AgentSnapshot, AgentSnapshotUpdate} from "../agent-snapshot";

type SnapshotClient = Pick<
  AgentClient,
  | "notifications"
  | "watch"
  | "profile"
  | "approvals"
  | "schedules"
  | "metadata"
  | "children"
  | "history"
>;

/** Loads the local demo view from the per-agent protocol. */
export async function loadAgentSnapshot(
  client: SnapshotClient,
  signal: AbortSignal,
): Promise<AgentSnapshot> {
  signal.throwIfAborted();
  // Capture the watermark BEFORE reading data: changes during loading must
  // still wake the browser's first watch. This is not an atomic VO snapshot.
  const notification = await client.notifications();
  signal.throwIfAborted();
  const [profile, approvals, schedules, metadata, children, history] =
    await Promise.all([
      client.profile(),
      client.approvals(),
      client.schedules(),
      client.metadata(),
      client.children(),
      readHistory(client, signal, 1),
    ]);
  signal.throwIfAborted();
  return {
    notification,
    profile,
    approvals,
    schedules,
    metadata,
    children,
    history,
  };
}

/** Wait once, then fetch only the data invalidated since the browser's cursor. */
export async function syncAgentSnapshot(
  client: SnapshotClient,
  since: AgentSnapshot["notification"],
  fromSequence: number,
  options: {signal: AbortSignal; idempotencyKey?: string},
): Promise<AgentSnapshotUpdate> {
  options.signal.throwIfAborted();
  const notification = await client.watch(since.revision, 25, options);
  options.signal.throwIfAborted();
  return readAgentSnapshotUpdate(
    client,
    since,
    notification,
    fromSequence,
    options.signal,
  );
}

async function readAgentSnapshotUpdate(
  client: SnapshotClient,
  since: AgentSnapshot["notification"],
  notification: AgentSnapshot["notification"],
  fromSequence: number,
  signal: AbortSignal,
): Promise<AgentSnapshotUpdate> {
  signal.throwIfAborted();
  const result: AgentSnapshotUpdate = {notification};
  const changed = (topic: keyof typeof since.versions) =>
    notification.versions[topic] !== since.versions[topic];
  const reads: Promise<void>[] = [];
  // Profile changes can also change the child directory and display name.
  if (changed("profile")) {
    reads.push(
      Promise.all([
        client.profile(),
        client.children(),
        client.metadata(),
      ]).then(([profile, children, metadata]) => {
        result.profile = profile;
        result.children = children;
        result.metadata = metadata;
      }),
    );
  }
  if (changed("approvals")) {
    reads.push(
      client.approvals().then((value) => {
        result.approvals = value;
      }),
    );
  }
  if (changed("schedules")) {
    reads.push(
      client.schedules().then((value) => {
        result.schedules = value;
      }),
    );
  }
  if (changed("history")) {
    reads.push(
      readHistory(client, signal, fromSequence).then((value) => {
        result.history = value;
      }),
    );
  }
  await Promise.all(reads);
  signal.throwIfAborted();
  return result;
}

async function readHistory(
  client: SnapshotClient,
  signal: AbortSignal,
  fromSequence: number,
): Promise<AgentSnapshot["history"]> {
  const entries: AgentSnapshot["history"]["entries"] = [];
  let nextSequence = fromSequence;
  while (true) {
    signal.throwIfAborted();
    const page = await client.history(nextSequence, 100);
    signal.throwIfAborted();
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
