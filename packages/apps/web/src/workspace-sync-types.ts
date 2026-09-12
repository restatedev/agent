import type {UserProfile} from "@restate-agents/types";
import type {AgentSnapshotUpdate} from "./agent-client";

export type WorkspaceSyncResponse = {
  authorization?: string;
  userId: string;
  revision: number | null;
  profileRevision: number;
  profile?: UserProfile;
  agentIds: string[];
  agents: Array<{agentId: string; reset: boolean; data: AgentSnapshotUpdate}>;
  completions: Array<{agentId: string; sequence: number}>;
  errors?: Array<{agentId: string; message: string}>;
};
