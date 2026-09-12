import type {AgentClient} from "@restate-agents/client";
import type {AgentSnapshot, AgentSnapshotUpdate} from "../agent-client";

type SnapshotClient = Pick<
  AgentClient,
  | "notifications"
  | "watchNotifications"
  | "profile"
  | "approvals"
  | "mcpAuthorizations"
  | "history"
>;

/** Caller must authorize the agent before supplying its client. */
export async function loadAgentSnapshot(
  client: SnapshotClient,
  signal: AbortSignal,
  watermark?: AgentSnapshot["notification"],
): Promise<AgentSnapshot> {
  signal.throwIfAborted();
  // Capture the watermark BEFORE reading data: changes during loading must
  // still wake the browser's first watch. This is not an atomic VO snapshot.
  const notification = watermark ?? (await client.notifications());
  signal.throwIfAborted();
  const [profile, approvals, mcpAuthorizations, history] = await Promise.all([
    client.profile(),
    client.approvals(),
    client.mcpAuthorizations(),
    readHistory(client, signal, 1),
  ]);
  signal.throwIfAborted();
  return {
    notification,
    profile,
    approvals,
    mcpAuthorizations,
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
  const notification = await client.watchNotifications(
    since.revision,
    25,
    options,
  );
  options.signal.throwIfAborted();
  return readAgentSnapshotUpdate(
    client,
    since,
    notification,
    fromSequence,
    options.signal,
  );
}

export async function readAgentSnapshotUpdate(
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
  await Promise.all([
    changed("profile") &&
      client.profile().then((value) => {
        result.profile = value;
      }),
    changed("approvals") &&
      client.approvals().then((value) => {
        result.approvals = value;
      }),
    changed("mcpAuth") &&
      client.mcpAuthorizations().then((value) => {
        result.mcpAuthorizations = value;
      }),
    changed("history") &&
      readHistory(client, signal, fromSequence).then((value) => {
        result.history = value;
      }),
  ]);
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
    if (page.entries.length < 100) return {entries, nextSequence};
  }
}
