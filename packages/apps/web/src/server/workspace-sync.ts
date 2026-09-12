import type {AgentClient, createUserClient} from "@restate-agents/client";
import type {
  AgentNotificationSnapshot,
  UserProfile,
  WorkspaceSyncRequest,
} from "@restate-agents/types";
import type {WorkspaceSyncResponse} from "../workspace-sync-types";
import {loadAgentSnapshot, readAgentSnapshotUpdate} from "./agent-snapshot";

export class WorkspaceSyncError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
type Identity = {
  userId: string;
  sessionId?: string;
  client: ReturnType<typeof createUserClient>;
};
type Scope = {
  agentIds: string[];
  authorization?: string;
  profile?: UserProfile;
};
const empty: AgentNotificationSnapshot = {
  revision: 0,
  versions: {history: 0, profile: 0, approvals: 0, mcpAuth: 0, schedules: 0},
};

/** Authentication is supplied by the BFF's cookie/session boundary, never input. */
export async function syncWorkspace<T extends Identity>(
  request: WorkspaceSyncRequest,
  dependencies: {
    authenticate: () => Promise<T>;
    authorize: (user: T, token?: string, force?: boolean) => Promise<Scope>;
    agent: (id: string) => AgentClient;
  },
  signal: AbortSignal,
): Promise<WorkspaceSyncResponse> {
  const user = await dependencies.authenticate();
  let scope = await dependencies.authorize(user, request.authorization);
  const owned = new Set(scope.agentIds);
  // Validate ALL requested IDs before any agent read or notification watch.
  if (
    new Set(request.agents.map((a) => a.agentId)).size !== request.agents.length
  )
    throw new WorkspaceSyncError(400, "Duplicate agent cursor");
  if (request.agents.some((a) => !owned.has(a.agentId)))
    throw new WorkspaceSyncError(404, "Agent not found");
  signal.throwIfAborted();
  let notification = await user.client.notifications();
  const needsLoad = request.agents.some((a) => !a.notification);
  if (
    !needsLoad &&
    request.revision === notification.revision &&
    request.profileRevision === notification.profileRevision
  ) {
    notification = await user.client.watchNotifications(notification.revision, {
      signal,
    });
  }
  signal.throwIfAborted();
  // Recheck the lease after waiting; expiry forces backing session validation.
  const currentUser = await dependencies.authenticate();
  if (
    currentUser.userId !== user.userId ||
    currentUser.sessionId !== user.sessionId
  )
    throw new WorkspaceSyncError(401, "Session changed");
  // Watermark is captured BEFORE fetching data, including the directory.
  const reset =
    request.revision !== null && request.revision > notification.revision;
  scope = await dependencies.authorize(
    currentUser,
    scope.authorization,
    reset || request.profileRevision !== notification.profileRevision,
  );
  const currentIds = new Set(scope.agentIds);
  const result: WorkspaceSyncResponse = {
    userId: user.userId,
    authorization: scope.authorization,
    revision: notification.revision,
    profileRevision: notification.profileRevision,
    ...(scope.profile ? {profile: scope.profile} : {}),
    agentIds: [...currentIds],
    agents: [],
    completions: [],
  };
  const requested = new Map(request.agents.map((a) => [a.agentId, a]));
  // Only enumerate the authenticated directory; never the feed's agent IDs.
  // Deleted agents are omitted even if late internal notifications arrive.
  for (let offset = 0; offset < scope.agentIds.length; offset += 8) {
    await Promise.all(
      scope.agentIds.slice(offset, offset + 8).map(async (agentId) => {
        signal.throwIfAborted();
        const marker = Object.hasOwn(notification.agents, agentId)
          ? notification.agents[agentId]
          : empty;
        const cursor = requested.get(agentId);
        const needsCompletion =
          reset ||
          request.revision === null ||
          marker.versions.history > request.revision ||
          request.profileRevision !== notification.profileRevision;
        if (!cursor && !needsCompletion) return;
        try {
          const client = dependencies.agent(agentId);
          if (needsCompletion)
            result.completions.push({
              agentId,
              sequence: await client.lastTurnSequence({signal}),
            });
          if (!cursor) return;
          const reload =
            reset ||
            !cursor.notification ||
            cursor.notification.revision > marker.revision;
          const data = reload
            ? await loadAgentSnapshot(client, signal, marker)
            : await readAgentSnapshotUpdate(
                client,
                cursor.notification ?? empty,
                marker,
                cursor.nextSequence,
                signal,
              );
          if (
            reload ||
            Object.keys(data).length > 1 ||
            data.notification.revision !== cursor.notification?.revision
          )
            result.agents.push({agentId, reset: reload, data});
        } catch {
          signal.throwIfAborted();
          // One unavailable agent must not block the rest of the workspace.
          // Keep the global cursor behind until its completion marker is fetched.
          result.revision = request.revision;
          result.errors ??= [];
          result.errors.push({
            agentId,
            message: "Agent data is temporarily unavailable",
          });
        }
      }),
    );
  }
  signal.throwIfAborted();
  // Revalidate before releasing a long history fetch as well.
  const finalUser = await dependencies.authenticate();
  if (
    finalUser.userId !== user.userId ||
    finalUser.sessionId !== user.sessionId
  )
    throw new WorkspaceSyncError(401, "Session changed");
  return result;
}
