import type {
  AgentProfile,
  ApprovalRequest,
  ScheduledMessage,
} from "@restate-agents/types";
import {Brain, type LucideIcon, Settings2, ShieldCheck} from "lucide-react";
import {useState} from "react";

import type {UiAgentClient} from "./agent-client";
import {ApprovalsPanel} from "./approvals-panel";
import type {Notify} from "./format";
import {MemoriesAndSchedules} from "./memories-schedules";
import {ProfilePanel} from "./profile-panel";
import type {SaveProfile} from "./use-agent";

type Tab = "approvals" | "profile" | "memory";
type TabSpec = {id: Tab; label: string; icon: LucideIcon};

const APPROVALS_TAB: TabSpec = {
  id: "approvals",
  label: "Approvals",
  icon: ShieldCheck,
};
const PROFILE_TAB: TabSpec = {id: "profile", label: "Context", icon: Settings2};
const MEMORY_TAB: TabSpec = {id: "memory", label: "Memory", icon: Brain};

/**
 * The side panel: pending approvals, the profile (top-level agents only), and
 * saved memories and schedules.
 */
export function Inspector({
  readOnly,
  approvals,
  profile,
  schedules,
  client,
  notify,
  saveProfile,
}: {
  readOnly: boolean;
  approvals: ApprovalRequest[];
  profile?: AgentProfile;
  schedules: ScheduledMessage[];
  client: UiAgentClient;
  notify: Notify;
  saveProfile: SaveProfile;
}) {
  const [selected, setSelected] = useState<Tab>("approvals");
  // A read-only child has no editable profile.
  const tabs = readOnly
    ? [APPROVALS_TAB, MEMORY_TAB]
    : [APPROVALS_TAB, PROFILE_TAB, MEMORY_TAB];
  // Metadata can reveal a parent (read-only child) after the user picked the
  // Context tab; fall back to one that still exists instead of an empty panel.
  const shown = tabs.some(({id}) => id === selected) ? selected : "approvals";

  return (
    <aside className="inspector">
      <div className="inspector-tabs" role="tablist">
        {tabs.map(({id, label, icon: Icon}) => (
          <button
            aria-selected={shown === id}
            data-active={shown === id}
            key={id}
            onClick={() => setSelected(id)}
            role="tab"
            type="button"
          >
            <Icon /> {label}
            {id === "approvals" && approvals.length > 0 && (
              <span>{approvals.length}</span>
            )}
          </button>
        ))}
      </div>
      <div className="inspector-content" role="tabpanel">
        {shown === "approvals" && (
          <ApprovalsPanel
            approvals={approvals}
            client={client}
            notify={notify}
          />
        )}
        {shown === "profile" && (
          <ProfilePanel
            client={client}
            notify={notify}
            profile={profile}
            saveProfile={saveProfile}
          />
        )}
        {shown === "memory" && (
          <MemoriesAndSchedules
            client={client}
            notify={notify}
            readOnly={readOnly}
            memories={profile?.memories ?? []}
            schedules={schedules}
          />
        )}
      </div>
    </aside>
  );
}
