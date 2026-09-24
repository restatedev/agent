import type {ApprovalRequest} from "@restate-agents/types";
import {Check, ShieldCheck, X} from "lucide-react";
import {useState} from "react";

import type {UiAgentClient} from "./agent-client";
import {type Notify, runAction, shortTurn} from "./format";

type Decision = "approved" | "rejected";

const DECISIONS: Array<{
  decision: Decision;
  label: string;
  className: string;
  icon: typeof Check;
}> = [
  {decision: "approved", label: "Approve", className: "approve", icon: Check},
  {decision: "rejected", label: "Reject", className: "reject", icon: X},
];

function ApprovalCard({
  approval,
  client,
  notify,
}: {
  approval: ApprovalRequest;
  client: UiAgentClient;
  notify: Notify;
}) {
  const [reason, setReason] = useState("");
  const [resolving, setResolving] = useState(false);

  async function resolve(decision: Decision) {
    setResolving(true);
    await runAction(notify, async () => {
      const trimmed = reason.trim();
      const delivered = await client.resolveApproval({
        approvalId: approval.approvalId,
        decision,
        ...(trimmed ? {reason: trimmed} : {}),
      });
      if (!delivered) {
        return ["That approval is no longer eligible", true];
      }
      return `Decision delivered: ${decision}`;
    });
    setResolving(false);
  }

  const source = approval.guardrailId
    ? `Guardrail · ${approval.guardrailId}`
    : "Agent request";
  return (
    <article className="approval-card">
      <div className="card-kicker">
        <ShieldCheck />
        {source}
      </div>
      <h3>{approval.question}</h3>
      <p className="card-meta">
        turn {shortTurn(approval.turnId)} · {approval.approvalId}
      </p>
      <input
        aria-label="Optional approval reason"
        onChange={(event) => setReason(event.target.value)}
        placeholder="Optional reason for the model"
        value={reason}
      />
      <div className="card-actions">
        {DECISIONS.map(({decision, label, className, icon: Icon}) => (
          <button
            className={`button ${className}`}
            disabled={resolving}
            key={decision}
            onClick={() => void resolve(decision)}
            type="button"
          >
            <Icon />
            {label}
          </button>
        ))}
      </div>
    </article>
  );
}

/** Pending human decisions, each resolved with an optional reason. */
export function ApprovalsPanel({
  approvals,
  client,
  notify,
}: {
  approvals: ApprovalRequest[];
  client: UiAgentClient;
  notify: Notify;
}) {
  if (approvals.length === 0) {
    return (
      <div className="panel-empty">
        <ShieldCheck />
        <strong>No pending approvals</strong>
        <span>
          Human decisions requested by tools and guardrails appear here.
        </span>
      </div>
    );
  }
  return (
    <div className="card-list">
      {approvals.map((approval) => (
        <ApprovalCard
          approval={approval}
          client={client}
          key={approval.approvalId}
          notify={notify}
        />
      ))}
    </div>
  );
}
