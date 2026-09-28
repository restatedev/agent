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
import {useMemo, useState} from "react";

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
import {shortTurn} from "./format";
import {renderInline, renderMarkdown} from "./markdown";
import {
  type AssistantEntry,
  type DetailEntry,
  describeToolBatch,
  isDetailEntry,
  type ToolsEntry,
} from "./transcript-entries";

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

function transcriptRows(entries: SequencedEntry[]): TranscriptRow[] {
  // Read terminal status first so every segment of a finished turn renders
  // consistently, even when a user message splits its details into two rows.
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
    if (isDetailEntry(entry)) {
      const turnId = entry.turnId;
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
      currentTurn.entries.push(entry);
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

type ToolCall = ToolsEntry["calls"][number];

/** A started batch shows play; a finished one shows each call's outcome. */
function ToolCallIcon({
  phase,
  call,
}: {
  phase: ToolsEntry["phase"];
  call: ToolCall;
}) {
  if (phase === "started") {
    return <Play />;
  }
  switch (call.status) {
    case "succeeded":
      return <Check />;
    case "failed":
      return <X />;
    case "cancelled":
      return <Ban />;
    default:
      return <Hourglass />;
  }
}

function ToolLines({entry}: {entry: ToolsEntry}) {
  return (
    <div className="tool-lines">
      {entry.calls.map((call) => {
        return (
          <div
            className="tool-line"
            data-status={call.status}
            key={`${entry.phase}-${call.id}`}
          >
            <span className="tool-icon">
              <ToolCallIcon phase={entry.phase} call={call} />
            </span>
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
            // oxlint-disable-next-line react/no-danger
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

function TurnStatusIcon({status}: {status: TurnRow["terminal"]}) {
  switch (status) {
    case "completed":
      return <CheckCircle2 />;
    case "failed":
      return <X />;
    case "interrupted":
    case "stopped":
      return <Ban />;
    default:
      return <Sparkles className="thinking-icon" />;
  }
}

function plural(count: number, noun: string) {
  const suffix = count === 1 ? "" : "s";
  return `${count} ${noun}${suffix}`;
}

/** "3 steps · 2 tool calls", or "Starting" before the first step. */
function turnSummary(steps: number, tools: number) {
  const progress = steps > 0 ? plural(steps, "step") : "Starting";
  if (tools === 0) {
    return progress;
  }
  return `${progress} · ${plural(tools, "tool call")}`;
}

function TurnCard({row}: {row: TurnRow}) {
  const [open, setOpen] = useState(!row.terminal);
  // Collapse once when the turn finishes; the user may reopen it afterwards.
  // Adjusted during render rather than in an effect to avoid a second render
  // pass (https://react.dev/learn/you-might-not-need-an-effect).
  const [seenTerminal, setSeenTerminal] = useState(row.terminal);
  if (row.terminal !== seenTerminal) {
    setSeenTerminal(row.terminal);
    if (row.terminal) {
      setOpen(false);
    }
  }

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
      live = describeToolBatch(entry);
    }
  }

  return (
    <details
      className="turn-card"
      data-status={row.terminal ?? "running"}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="turn-status-icon">
          <TurnStatusIcon status={row.terminal} />
        </span>
        <span className="turn-summary-copy">
          <strong>{row.terminal ?? "Working"}</strong>
          <span>{turnSummary(steps, tools)}</span>
        </span>
        {!row.terminal && <span className="turn-live shimmer">{live}</span>}
        <ChevronRight className="turn-chevron" />
      </summary>
      <div className="turn-body">
        {row.entries.map((entry, index) => (
          // Turn details form an append-only sequence, so their position is a
          // stable identity for the lifetime of the turn.
          // oxlint-disable-next-line react/no-array-index-key
          <TurnDetail entry={entry} key={`${entry.type}-${index}`} />
        ))}
      </div>
    </details>
  );
}

/**
 * One detail of a turn that resumed after a user message: activity reads as
 * agent prose, and "thinking" progress is noise once the agent is talking.
 */
function ContinuationDetail({entry}: {entry: DetailEntry}) {
  if (entry.type === "activity") {
    return (
      <div
        className="turn-continuation-copy"
        // The renderer escapes every source character before adding formatting tags.
        // oxlint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{__html: renderInline(entry.message)}}
      />
    );
  }
  if (entry.type === "progress" && entry.phase === "thinking") {
    return null;
  }
  return <TurnDetail entry={entry} />;
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
          {row.entries.map((entry, index) => (
            // Turn details form an append-only sequence, so their position is stable.
            // oxlint-disable-next-line react/no-array-index-key
            <ContinuationDetail entry={entry} key={`${entry.type}-${index}`} />
          ))}
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
  if (entry.role !== "user") {
    return null;
  }
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
  if (entry.role !== "assistant") {
    return null;
  }
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
            // oxlint-disable-next-line react/no-danger
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
  if (entry.role !== "event") {
    return null;
  }
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
    case "stop":
      // The runtime stopped the turn itself (today only at the step limit);
      // like an interrupt, it finalizes without tools and says why.
      return (
        <Marker variant="separator" className="marker-important">
          <MarkerIcon>
            <Ban />
          </MarkerIcon>
          <MarkerContent>
            Turn stopped · <em>{entry.reason}</em>
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
              .map((change) => `${change.operation} ${change.id}`)
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
  if (item.entry.role === "user") {
    return <UserMessage item={item} />;
  }
  if (item.entry.role === "assistant") {
    return <AssistantMessage item={item} />;
  }
  return <LifecycleEvent item={item} />;
}

/** Stable across polls: a turn row starts at a fixed sequence. */
function rowId(row: TranscriptRow) {
  if (row.kind === "turn") {
    return `turn-${row.turnId}-${row.sequence}`;
  }
  return `entry-${row.item.sequence}`;
}

function Row({row}: {row: TranscriptRow}) {
  if (row.kind === "entry") {
    return <Entry item={row.item} />;
  }
  if (row.continuation) {
    return <TurnContinuation row={row} />;
  }
  return <TurnCard row={row} />;
}

function isAnchor(row: TranscriptRow) {
  if (row.kind === "turn") {
    return false;
  }
  const {entry} = row.item;
  return (
    (entry.role === "user" && entry.delivery !== "queued") ||
    (entry.role === "event" && entry.type === "dispatch")
  );
}

export function Transcript({
  entries,
  busy,
}: {
  entries: SequencedEntry[];
  busy: boolean;
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
            {rows.length === 0 && (
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
                key={rowId(row)}
                messageId={rowId(row)}
                scrollAnchor={isAnchor(row)}
              >
                <Row row={row} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
