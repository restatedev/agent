import type {AgentProfile, ApprovalRequest} from "@restate-agents/types";
import {type LucideIcon, Settings2, ShieldCheck} from "lucide-react";
import {useState} from "react";

import type {UiAgentClient} from "./agent-client";
import {ApprovalsPanel} from "./approvals-panel";
import type {Notify} from "./format";
import {ProfilePanel} from "./profile-panel";
import type {SaveProfile} from "./use-agent";

type Tab = "approvals" | "profile";
type TabSpec = {id: Tab; label: string; icon: LucideIcon};

const APPROVALS_TAB: TabSpec = {
  id: "approvals",
  label: "Approvals",
  icon: ShieldCheck,
};
const PROFILE_TAB: TabSpec = {id: "profile", label: "Context", icon: Settings2};

/** The side panel: pending approvals and, for top-level agents, the profile. */
export function Inspector({
  readOnly,
  approvals,
  profile,
  client,
  notify,
  saveProfile,
}: {
  readOnly: boolean;
  approvals: ApprovalRequest[];
  profile?: AgentProfile;
  client: UiAgentClient;
  notify: Notify;
  saveProfile: SaveProfile;
}) {
  const [selected, setSelected] = useState<Tab>("approvals");
  // A read-only child has no editable profile.
  const tabs = readOnly ? [APPROVALS_TAB] : [APPROVALS_TAB, PROFILE_TAB];
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
      </div>
    </aside>
  );
}
