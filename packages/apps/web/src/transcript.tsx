import {
  Ban,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Flag,
  GitBranch,
  Hourglass,
  MemoryStick,
  Play,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  Sparkles,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import {type ReactNode, useEffect, useMemo, useState} from "react";
import type {SequencedEntry} from "./agent-client";
import {Bubble, BubbleContent} from "./components/ui/bubble";
import {Marker, MarkerContent, MarkerIcon} from "./components/ui/marker";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "./components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./components/ui/message-scroller";
import {renderInline, renderMarkdown} from "./markdown";

type TranscriptEntry = SequencedEntry["entry"];
type EventEntry = Extract<TranscriptEntry, {role: "event"}>;
type DetailEntry = Extract<
  EventEntry,
  {type: "progress" | "activity" | "tools" | "steer" | "approval_cancelled"}
>;
type AssistantEntry = Extract<TranscriptEntry, {role: "assistant"}>;

type EntryRow = {
  kind: "entry";
  item: SequencedEntry;
};

type TurnRow = {
  kind: "turn";
  sequence: number;
  turnId: string;
  entries: DetailEntry[];
  continuation: boolean;
  terminal?: AssistantEntry["status"];
};

type TranscriptRow = EntryRow | TurnRow;

const detailTypes = new Set<EventEntry["type"]>([
  "progress",
  "activity",
  "tools",
  "steer",
  "approval_cancelled",
]);

function shortTurn(turnId: string) {
  return turnId.length > 14 ? `${turnId.slice(0, 14)}…` : turnId;
}

function transcriptRows(entries: SequencedEntry[]): TranscriptRow[] {
  const terminalByTurn = new Map<string, AssistantEntry["status"]>();
  for (const {entry} of entries) {
    if (entry.role === "assistant") {
      terminalByTurn.set(entry.turnId, entry.status);
    }
  }

  const rows: TranscriptRow[] = [];
  const seenTurns = new Set<string>();
  let currentTurn: TurnRow | undefined;
  for (const item of entries) {
    const {entry} = item;
    if (
      entry.role === "event" &&
      detailTypes.has(entry.type) &&
      "turnId" in entry
    ) {
      const turnId = entry.turnId;
      if (!turnId) {
        rows.push({kind: "entry", item});
        currentTurn = undefined;
        continue;
      }
      if (!currentTurn || currentTurn.turnId !== turnId) {
        currentTurn = {
          kind: "turn",
          sequence: item.sequence,
          turnId,
          entries: [],
          continuation: seenTurns.has(turnId),
          terminal: terminalByTurn.get(turnId),
        };
        seenTurns.add(turnId);
        rows.push(currentTurn);
      }
      currentTurn.entries.push(entry as DetailEntry);
      continue;
    }
    rows.push({kind: "entry", item});
    // A user steering message or lifecycle marker is a chronological boundary.
    // Later activity from the same Turn must render after it, not be folded
    // back into the Turn card that appeared before the message.
    currentTurn = undefined;
  }
  return rows;
}

function phaseIcon(phase: string) {
  switch (phase) {
    case "thinking":
      return <Brain />;
    case "waiting":
      return <Hourglass />;
    case "finalizing":
      return <Flag />;
    default:
      return <CircleDot />;
  }
}

function ToolLines({entry}: {entry: Extract<DetailEntry, {type: "tools"}>}) {
  return (
    <div className="tool-lines">
      {entry.calls.map((call) => {
        const icon =
          entry.phase === "started" ? (
            <Play />
          ) : call.status === "succeeded" ? (
            <Check />
          ) : call.status === "failed" ? (
            <X />
          ) : call.status === "cancelled" ? (
            <Ban />
          ) : (
            <Hourglass />
          );
        return (
          <div
            className="tool-line"
            data-status={call.status}
            key={`${entry.phase}-${call.id}`}
          >
            <span className="tool-icon">{icon}</span>
            <span>{call.summary ?? call.name}</span>
          </div>
        );
      })}
    </div>
  );
}

function TurnDetail({entry}: {entry: DetailEntry}) {
  switch (entry.type) {
    case "progress":
      return (
        <div className="turn-detail progress-detail">
          <span className="detail-icon">{phaseIcon(entry.phase)}</span>
          <span>{entry.message}</span>
        </div>
      );
    case "activity":
      return (
        <div className="turn-detail activity-detail">
          <span className="step-chip">Step {entry.step}</span>
          <span
            // The renderer escapes every source character before adding formatting tags.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized model output
            dangerouslySetInnerHTML={{__html: renderInline(entry.message)}}
          />
        </div>
      );
    case "tools":
      return (
        <div className="turn-detail tool-detail">
          <div className="tool-heading">
            <Wrench />
            <span>
              Step {entry.step} ·{" "}
              {entry.phase === "started" ? "Running" : "Finished"}
            </span>
          </div>
          <ToolLines entry={entry} />
        </div>
      );
    case "steer":
      return (
        <div className="turn-detail signal-detail">
          <GitBranch />
          <span>
            Steering delivered
            {entry.queuedMessages > 0
              ? ` · ${entry.queuedMessages} queued message(s) promoted`
              : ""}
          </span>
        </div>
      );
    case "approval_cancelled":
      return (
        <div className="turn-detail signal-detail">
          <ShieldX />
          <span>Approval request withdrawn · {entry.approvalId}</span>
        </div>
      );
  }
}

function TurnCard({row}: {row: TurnRow}) {
  const [open, setOpen] = useState(!row.terminal);
  useEffect(() => {
    if (row.terminal) {
      setOpen(false);
    }
  }, [row.terminal]);

  let steps = 0;
  let tools = 0;
  let live = "Starting turn";
  for (const entry of row.entries) {
    if (entry.type === "activity" || entry.type === "tools") {
      steps = Math.max(steps, entry.step);
    }
    if (entry.type === "tools" && entry.phase === "started") {
      tools += entry.calls.length;
    }
    if (entry.type === "activity" || entry.type === "progress") {
      live = entry.message;
    } else if (entry.type === "tools") {
      live = `${entry.phase === "started" ? "Running" : "Finished"} ${entry.calls
        .map((call) => call.summary ?? call.name)
        .join(", ")}`;
    }
  }

  const statusIcon =
    row.terminal === "completed" ? (
      <CheckCircle2 />
    ) : row.terminal === "failed" ? (
      <X />
    ) : row.terminal === "interrupted" || row.terminal === "stopped" ? (
      <Ban />
    ) : (
      <Sparkles className="thinking-icon" />
    );

  return (
    <details
      className="turn-card"
      data-status={row.terminal ?? "running"}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="turn-status-icon">{statusIcon}</span>
        <span className="turn-summary-copy">
          <strong>{row.terminal ? row.terminal : "Working"}</strong>
          <span>
            {steps > 0 ? `${steps} step${steps === 1 ? "" : "s"}` : "Starting"}
            {tools > 0 ? ` · ${tools} tool call${tools === 1 ? "" : "s"}` : ""}
          </span>
        </span>
        {!row.terminal && <span className="turn-live shimmer">{live}</span>}
        <ChevronRight className="turn-chevron" />
      </summary>
      <div className="turn-body">
        {row.entries.map((entry, index) => (
          // Turn details form an append-only sequence, so their position is a
          // stable identity for the lifetime of the turn.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <TurnDetail entry={entry} key={`${entry.type}-${index}`} />
        ))}
      </div>
    </details>
  );
}

function TurnContinuation({row}: {row: TurnRow}) {
  return (
    <Message className="turn-continuation">
      <MessageAvatar>
        <Bot />
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>Agent</MessageHeader>
        <div className="turn-continuation-flow">
          {row.entries.map((entry, index) =>
            entry.type === "activity" ? (
              <div
                className="turn-continuation-copy"
                // The renderer escapes every source character before adding formatting tags.
                // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized model output
                dangerouslySetInnerHTML={{__html: renderInline(entry.message)}}
                // Turn details form an append-only sequence, so their position is stable.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                key={`${entry.type}-${index}`}
              />
            ) : entry.type === "progress" &&
              entry.phase === "thinking" ? null : (
              // Turn details form an append-only sequence, so their position is stable.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <TurnDetail entry={entry} key={`${entry.type}-${index}`} />
            ),
          )}
        </div>
      </MessageContent>
    </Message>
  );
}

function Badge({children, tone}: {children: string; tone?: string}) {
  return (
    <span className="message-badge" data-tone={tone}>
      {children}
    </span>
  );
}

function UserMessage({item}: {item: SequencedEntry}) {
  const entry = item.entry;
  if (entry.role !== "user") return null;
  return (
    <Message align="end">
      <MessageAvatar>
        {entry.delegatedBy ? <Bot /> : <UserRound />}
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>
          {entry.delegatedBy ? "Parent agent" : "You"}
        </MessageHeader>
        <Bubble align="end" variant="tinted">
          <BubbleContent>{entry.text}</BubbleContent>
        </Bubble>
        {entry.delivery !== "turn" && (
          <MessageFooter>
            <Badge tone={entry.delivery}>{entry.delivery}</Badge>
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}

function AssistantMessage({item}: {item: SequencedEntry}) {
  const entry = item.entry;
  if (entry.role !== "assistant") return null;
  return (
    <Message>
      <MessageAvatar>
        <Bot />
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>Agent</MessageHeader>
        <Bubble variant="outline">
          <BubbleContent
            className="markdown"
            // The renderer escapes every source character before adding formatting tags.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized model output
            dangerouslySetInnerHTML={{__html: renderMarkdown(entry.text)}}
          />
        </Bubble>
        <MessageFooter>
          {entry.status !== "completed" && (
            <Badge tone={entry.status}>{entry.status}</Badge>
          )}
          <span className="turn-id">{shortTurn(entry.turnId)}</span>
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

function LifecycleEvent({item}: {item: SequencedEntry}) {
  const entry = item.entry;
  if (entry.role !== "event") return null;
  switch (entry.type) {
    case "interrupt":
      return (
        <Marker variant="separator" className="marker-important">
          <MarkerIcon>
            <Ban />
          </MarkerIcon>
          <MarkerContent>
            Turn interrupted · <em>{entry.reason}</em>
          </MarkerContent>
        </Marker>
      );
    case "dispatch":
      return (
        <Marker variant="separator">
          <MarkerIcon>
            <Play />
          </MarkerIcon>
          <MarkerContent>
            {entry.queuedMessages} queued message(s) dispatched into a new turn
          </MarkerContent>
        </Marker>
      );
    case "memory":
      return (
        <Marker>
          <MarkerIcon>
            <MemoryStick />
          </MarkerIcon>
          <MarkerContent>
            Memory updated ·{" "}
            {entry.changes
              .map((change) => `${change.operation} ${change.key}`)
              .join(", ")}
          </MarkerContent>
        </Marker>
      );
    case "approval":
      return (
        <Marker
          className={
            entry.decision === "approved" ? "marker-success" : "marker-danger"
          }
        >
          <MarkerIcon>
            {entry.decision === "approved" ? <ShieldCheck /> : <ShieldX />}
          </MarkerIcon>
          <MarkerContent>
            {entry.decision === "approved" ? "Approved" : "Rejected"}
            {entry.guardrailId ? ` [${entry.guardrailId}]` : ""} ·{" "}
            {entry.question}
            {entry.reason ? ` (${entry.reason})` : ""}
          </MarkerContent>
        </Marker>
      );
    case "approval_request":
      return (
        <Marker className="marker-warning">
          <MarkerIcon>
            <ShieldQuestion />
          </MarkerIcon>
          <MarkerContent>
            Approval requested
            {entry.guardrailId ? ` [${entry.guardrailId}]` : ""} ·{" "}
            {entry.question}
          </MarkerContent>
        </Marker>
      );
    case "delivery":
      return (
        <Marker>
          <MarkerIcon>
            <Clock3 />
          </MarkerIcon>
          <MarkerContent>
            {entry.source === "schedule"
              ? "Schedule"
              : `Delivery from ${entry.source}`}
            {entry.sourceId ? ` “${entry.sourceId}”` : ""} · routed as{" "}
            {entry.routing}
          </MarkerContent>
        </Marker>
      );
    default:
      return (
        <Marker>
          <MarkerIcon>
            <CircleDot />
          </MarkerIcon>
          <MarkerContent>{entry.type}</MarkerContent>
        </Marker>
      );
  }
}

function Entry({item}: {item: SequencedEntry}) {
  if (item.entry.role === "user") return <UserMessage item={item} />;
  if (item.entry.role === "assistant") return <AssistantMessage item={item} />;
  return <LifecycleEvent item={item} />;
}

function isAnchor(row: TranscriptRow) {
  if (row.kind === "turn") return false;
  const {entry} = row.item;
  return (
    (entry.role === "user" && entry.delivery !== "queued") ||
    (entry.role === "event" && entry.type === "dispatch")
  );
}

export function Transcript({
  entries,
  busy,
  pendingAction,
}: {
  entries: SequencedEntry[];
  busy: boolean;
  pendingAction?: ReactNode;
}) {
  const rows = useMemo(() => transcriptRows(entries), [entries]);
  return (
    <MessageScrollerProvider
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={64}
    >
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent aria-busy={busy}>
            {rows.length === 0 && !pendingAction && (
              <div className="empty-conversation">
                <div className="empty-orbit">
                  <Sparkles />
                </div>
                <p className="eyebrow">Durable conversation</p>
                <h2>What should the agent work on?</h2>
                <p>
                  Start a turn, then steer it while tools run, interrupt it
                  gracefully, or inspect every durable lifecycle event as it
                  happens.
                </p>
              </div>
            )}
            {rows.map((row) => (
              <MessageScrollerItem
                key={
                  row.kind === "turn"
                    ? `turn-${row.turnId}-${row.sequence}`
                    : `entry-${row.item.sequence}`
                }
                messageId={
                  row.kind === "turn"
                    ? `turn-${row.turnId}-${row.sequence}`
                    : `entry-${row.item.sequence}`
                }
                scrollAnchor={isAnchor(row)}
              >
                {row.kind === "turn" ? (
                  row.continuation ? (
                    <TurnContinuation row={row} />
                  ) : (
                    <TurnCard row={row} />
                  )
                ) : (
                  <Entry item={row.item} />
                )}
              </MessageScrollerItem>
            ))}
            {pendingAction && (
              <MessageScrollerItem
                className="pending-action-item"
                messageId="pending-action"
                scrollAnchor
              >
                {pendingAction}
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
