"use client";

import {Activity} from "lucide-react";
import {useEffect, useMemo, useState} from "react";

import {AgentNavigation} from "./agent-navigation";
import {ChildControls, Composer} from "./composer";
import {Inspector} from "./inspector";
import {MemoriesAndSchedules} from "./memories-schedules";
import {ConnectionHeader, StatusStrip} from "./status";
import {Toasts, useToasts} from "./toasts";
import {Transcript} from "./transcript";
import {activeTurn, isRunning} from "./turn-state";
import {useAgent} from "./use-agent";

/** One agent's conversation page. The page remounts it per agent ID. */
export function App({initialAgentId}: {initialAgentId: string}) {
  const {toasts, notify} = useToasts();
  const agent = useAgent(initialAgentId, notify);
  const [provisionalTurn, setProvisionalTurn] = useState<string>();
  const agentName = agent.metadata?.name ?? initialAgentId;
  // Only a sub-agent's parent may send it tasks or edit its profile.
  const readOnly = Boolean(agent.metadata?.parentAgentId);
  const pendingTurnId = agent.approvals[0]?.turnId;
  const turn = useMemo(
    () => activeTurn(agent.entries, provisionalTurn, pendingTurnId),
    [agent.entries, pendingTurnId, provisionalTurn],
  );
  const busy = isRunning(turn);
  // A just-started turn is shown before its first entry arrives; forget it
  // once it is no longer active. Adjusted during render, not in an effect.
  if (provisionalTurn && !turn) {
    setProvisionalTurn(undefined);
  }

  useEffect(() => {
    document.title = `Restate Agent · ${initialAgentId}`;
  }, [initialAgentId]);

  return (
    <div className="app-shell">
      <ConnectionHeader
        connected={agent.connected}
        name={agentName}
        error={agent.connectionError}
      />
      <AgentNavigation
        agentId={initialAgentId}
        metadata={agent.metadata}
        childAgents={agent.children}
      />
      <main className="workspace" data-readonly={readOnly}>
        <section className="conversation-pane">
          <div className="conversation-heading">
            <div>
              <p className="eyebrow">Conversation</p>
              <h1>{agentName}</h1>
            </div>
            <div className="conversation-stat">
              <Activity />
              <span>{agent.entries.length} durable events</span>
            </div>
          </div>
          <div className="transcript-frame">
            <Transcript entries={agent.entries} busy={busy} />
          </div>
          <StatusStrip turn={turn} />
          {readOnly ? (
            <ChildControls
              client={agent.client}
              notify={notify}
              busy={busy}
              awaitingApproval={agent.approvals.length > 0}
            />
          ) : (
            <Composer
              client={agent.client}
              notify={notify}
              busy={busy}
              onTurnStarted={setProvisionalTurn}
            />
          )}
        </section>
        <Inspector
          readOnly={readOnly}
          approvals={agent.approvals}
          client={agent.client}
          notify={notify}
          profile={agent.profile}
          saveProfile={agent.saveProfile}
        />
      </main>
      <MemoriesAndSchedules
        client={agent.client}
        notify={notify}
        readOnly={readOnly}
        memories={agent.profile?.memories ?? []}
        schedules={agent.schedules}
      />
      <Toasts toasts={toasts} />
    </div>
  );
}
