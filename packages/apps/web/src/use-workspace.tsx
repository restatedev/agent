"use client";
import type {UserProfile} from "@restate-agents/types";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {AgentClientError} from "./agent-client";
import {userClient} from "./user-client";
import {createWorkspaceCache, type WorkspaceCache} from "./workspace-cache";

export const WorkspaceCacheContext = createContext<WorkspaceCache | null>(null);
export function useWorkspaceCache() {
  const cache = useContext(WorkspaceCacheContext);
  if (!cache) throw new Error("User workspace required");
  const state = useSyncExternalStore(
    cache.subscribe,
    cache.getSnapshot,
    cache.getSnapshot,
  );
  return {cache, state};
}
export function useWorkspace(initialUser: UserProfile, selected?: string) {
  const cache = useMemo(() => createWorkspaceCache(initialUser), [initialUser]);
  const state = useSyncExternalStore(
    cache.subscribe,
    cache.getSnapshot,
    cache.getSnapshot,
  );
  useEffect(() => {
    if (selected && state.profile.agents.some((a) => a.agentId === selected))
      cache.ensure(selected);
  }, [cache, selected, state.profile]);
  useEffect(() => {
    let stopped = false;
    let current: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let wakeDelay: (() => void) | undefined;
    const wake = () => {
      current?.abort();
      wakeDelay?.();
    };
    const unsubscribe = cache.onWake(wake);
    const focus = () => {
      if (document.visibilityState === "visible") wake();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    async function poll() {
      while (!stopped) {
        current = new AbortController();
        try {
          const update = await userClient.sync(cache.cursor(), current.signal);
          if (
            !stopped &&
            !current.signal.aborted &&
            update.userId !== cache.userId
          ) {
            cache.clear();
            window.location.reload();
            return;
          }
          if (!stopped && !current.signal.aborted) cache.apply(update);
          if (update.errors?.length)
            throw new Error("Some agent updates are unavailable; retrying");
        } catch (error) {
          if (stopped) return;
          if (current.signal.aborted) continue;
          if (
            error instanceof AgentClientError &&
            (error.status === 401 || error.status === 403)
          ) {
            cache.clear();
            window.location.reload();
            return;
          }
          if (error instanceof AgentClientError && error.status === 404) {
            try {
              const profile = await userClient.profile();
              if (!stopped && profile.identity.userId !== cache.userId) {
                cache.clear();
                window.location.reload();
                return;
              }
              if (!stopped) cache.setProfile(profile);
            } catch {}
          }
          cache.fail(error instanceof Error ? error.message : String(error));
          await new Promise<void>((resolve) => {
            wakeDelay = () => {
              clearTimeout(retry);
              resolve();
            };
            retry = setTimeout(resolve, 2000);
          });
          wakeDelay = undefined;
        }
      }
    }
    void poll();
    return () => {
      stopped = true;
      wake();
      unsubscribe();
      clearTimeout(retry);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [cache]);
  return {cache, state};
}
