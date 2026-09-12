import type {UserProfile, WorkspaceSyncRequest} from "@restate-agents/types";
import type {AgentSnapshot, AgentSnapshotUpdate} from "./agent-client";
import type {WorkspaceSyncResponse} from "./workspace-sync-types";

export type CachedAgent = Partial<AgentSnapshot>;
export type WorkspaceState = {
  agents: Record<string, CachedAgent>;
  profile: UserProfile;
  completions: Array<{agentId: string; sequence: number}>;
  status: "connecting" | "connected" | "failed";
  error?: string;
};

/** One browser workspace/account, never a module-global or persisted data cache. */
export function createWorkspaceCache(profile: UserProfile) {
  const userId = profile.identity.userId;
  let state: WorkspaceState = {
    profile,
    agents: {},
    completions: [],
    status: "connecting",
  };
  let revision: number | null = null;
  let profileRevision: number | null = null;
  let authorization: string | undefined;
  const listeners = new Set<() => void>();
  const wake = new Set<() => void>();
  function publish(next: WorkspaceState) {
    state = next;
    for (const listener of listeners) listener();
  }
  function retain(ids: Set<string>, agents = state.agents) {
    return Object.fromEntries(
      Object.entries(agents).filter(([id]) => ids.has(id)),
    );
  }
  return {
    userId,
    authorization: () => authorization,
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onWake(listener: () => void) {
      wake.add(listener);
      return () => {
        wake.delete(listener);
      };
    },
    ensure(agentId: string) {
      if (
        !state.profile.agents.some((a) => a.agentId === agentId) ||
        Object.hasOwn(state.agents, agentId)
      )
        return;
      publish({...state, agents: {...state.agents, [agentId]: {}}});
      for (const listener of wake) listener();
    },
    cursor(): WorkspaceSyncRequest {
      return {
        ...(authorization ? {authorization} : {}),
        revision,
        profileRevision,
        agents: Object.entries(state.agents).map(([agentId, cached]) => ({
          agentId,
          notification: cached.notification,
          nextSequence: cached.history?.nextSequence ?? 1,
        })),
      };
    },
    apply(update: WorkspaceSyncResponse) {
      if (
        update.userId !== userId ||
        (update.profile && update.profile.identity.userId !== userId)
      )
        throw new Error("Workspace identity mismatch");
      const agents = retain(new Set(update.agentIds));
      for (const {agentId, reset, data} of update.agents) {
        if (
          !update.agentIds.includes(agentId) ||
          !Object.hasOwn(agents, agentId)
        )
          continue;
        const old = agents[agentId];
        agents[agentId] = {
          ...(reset ? {} : old),
          ...data,
          ...(data.history
            ? {
                history: {
                  entries: reset
                    ? data.history.entries
                    : [
                        ...(old.history?.entries ?? []),
                        ...data.history.entries.filter(
                          (e) => e.sequence >= (old.history?.nextSequence ?? 1),
                        ),
                      ],
                  nextSequence: data.history.nextSequence,
                },
              }
            : {}),
        };
      }
      revision = update.revision;
      authorization = update.authorization;
      profileRevision = update.profileRevision;
      const completions = new Map(
        state.completions
          .filter((c) => update.agentIds.includes(c.agentId))
          .map((c) => [c.agentId, c.sequence]),
      );
      for (const c of update.completions)
        if (update.agentIds.includes(c.agentId))
          completions.set(c.agentId, c.sequence);
      publish({
        ...state,
        agents,
        profile: update.profile ?? {
          ...state.profile,
          agents: state.profile.agents.filter((a) =>
            update.agentIds.includes(a.agentId),
          ),
        },
        completions: [...completions].map(([agentId, sequence]) => ({
          agentId,
          sequence,
        })),
        status: "connected",
        error: undefined,
      });
    },
    patchAgent(agentId: string, data: Partial<AgentSnapshotUpdate>) {
      if (Object.hasOwn(state.agents, agentId))
        publish({
          ...state,
          agents: {
            ...state.agents,
            [agentId]: {...state.agents[agentId], ...data},
          },
        });
    },
    setProfile(next: UserProfile) {
      if (next.identity.userId !== userId)
        throw new Error("Workspace identity mismatch");
      publish({
        ...state,
        profile: next,
        agents: retain(new Set(next.agents.map((a) => a.agentId))),
      });
    },
    fail(message: string) {
      publish({...state, status: "failed", error: message});
    },
    clear() {
      revision = null;
      authorization = undefined;
      profileRevision = null;
      publish({
        ...state,
        agents: {},
        completions: [],
        profile: {...state.profile, agents: [], memories: [], connections: []},
        status: "failed",
      });
    },
  };
}
export type WorkspaceCache = ReturnType<typeof createWorkspaceCache>;
