"use client";

import {useEffect, useMemo, useState} from "react";

import {AgentNavigation} from "./agent-navigation";
import {ChildControls, Composer} from "./composer";
import {Inspector} from "./inspector";
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
        eventCount={agent.entries.length}
      >
        <AgentNavigation
          agentId={initialAgentId}
          metadata={agent.metadata}
          childAgents={agent.children}
        />
      </ConnectionHeader>
      <main className="workspace" data-readonly={readOnly}>
        <section className="conversation-pane" aria-label="Conversation">
          <div className="transcript-frame">
            <Transcript entries={agent.entries} busy={busy} />
          </div>
          {readOnly ? (
            <ChildControls
              client={agent.client}
              notify={notify}
              busy={busy}
              status={<StatusStrip turn={turn} />}
              awaitingApproval={agent.approvals.length > 0}
            />
          ) : (
            <Composer
              client={agent.client}
              notify={notify}
              busy={busy}
              status={<StatusStrip turn={turn} />}
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
          schedules={agent.schedules}
          saveProfile={agent.saveProfile}
        />
      </main>
      <Toasts toasts={toasts} />
    </div>
  );
}
