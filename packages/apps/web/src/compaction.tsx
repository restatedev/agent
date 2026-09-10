import {FileText} from "lucide-react";
import {useEffect, useRef} from "react";
import type {CompactionState} from "./use-agent";

/** Mount per agent: hydration shows durable status without replaying old toasts. */
export function CompactionNotice({
  state,
  notify,
  onView,
}: {
  state?: CompactionState;
  notify: (message: string, error?: boolean) => void;
  onView: () => void;
}) {
  const previous = useRef<CompactionState | undefined>(undefined);
  useEffect(() => {
    if (!state) return;
    const before = previous.current;
    previous.current = state;
    if (!before) return;
    if (
      state.summary &&
      state.summary.through > (before.summary?.through ?? 0)
    ) {
      notify(
        `Conversation compacted through event ${state.summary.through}. Summary available in Context.`,
      );
    } else if (
      state.lastAttempt?.status === "failed" &&
      JSON.stringify(state.lastAttempt) !== JSON.stringify(before.lastAttempt)
    ) {
      notify(
        "Conversation compaction failed. History and the previous summary were preserved; see Context.",
        true,
      );
    }
  }, [state, notify]);

  if (!state || (!state.pending && !state.summary && !state.lastAttempt))
    return null;
  const label = state.pending
    ? "Compacting conversation…"
    : state.lastAttempt?.status === "failed"
      ? "Compaction failed — view details"
      : `Context compacted through event ${state.summary?.through} — view summary`;
  return (
    <div role="status" className="compaction-notice">
      <button type="button" onClick={onView}>
        <FileText />
        {label}
      </button>
    </div>
  );
}

export function ConversationSummary({state}: {state?: CompactionState}) {
  return (
    <section id="conversation-summary" className="settings-section">
      <div className="section-heading">
        <div>
          <FileText />
          <span>
            <strong>Conversation summary</strong>
            <small>Derived model context · original history retained</small>
          </span>
        </div>
      </div>
      {!state ? (
        <p>Loading summary…</p>
      ) : (
        <>
          {state.pending && (
            <p role="status">
              Compacting events {state.pending.baseThrough + 1}–
              {state.pending.through}…
            </p>
          )}
          {!state.pending && state.lastAttempt?.status === "failed" && (
            <p role="alert" className="compaction-error">
              Compaction failed: {state.lastAttempt.error}
            </p>
          )}
          {state.summary ? (
            <>
              <p className="compaction-help">
                Covers events 1–{state.summary.through}. Later turns load this
                summary plus newer messages; an already-running turn keeps its
                original context.
              </p>
              <textarea
                className="conversation-summary-text"
                aria-label="Conversation summary text"
                readOnly
                rows={12}
                value={state.summary.text}
              />
            </>
          ) : (
            <p className="compaction-help">
              No summary yet. Automatic compaction starts after a turn ends with
              at least 32 new user/assistant messages since the previous
              summary.
            </p>
          )}
          <p className="compaction-help">
            Compaction reduces model context, not stored history. Original
            messages remain in the conversation.
          </p>
        </>
      )}
    </section>
  );
}
