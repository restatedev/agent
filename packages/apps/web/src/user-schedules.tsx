"use client";
import type {UserSchedule, UserScheduleSpec} from "@restate-agents/types";
import {AlarmClock, ArrowRight, Pencil, Plus, Trash2, X} from "lucide-react";
import {useState} from "react";
import {userClient} from "./user-client";
import {useUser} from "./user-context";

const blank = () => ({
  scheduleId: "",
  name: "",
  message: "",
  delay: "300",
  repeat: "86400",
  tools: null as UserScheduleSpec["tools"],
});
function duration(seconds: number) {
  for (const [size, unit] of [
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
    [1, "second"],
  ] as const) {
    if (seconds % size === 0) {
      const count = seconds / size;
      return `${count} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return String(seconds);
}

export function UserSchedules({
  onOpenAgent,
  onDeleteAgent,
  unread,
}: {
  onOpenAgent: (id: string) => void;
  onDeleteAgent: (id: string, name: string) => Promise<void>;
  unread: ReadonlySet<string>;
}) {
  const {profile, refresh} = useUser();
  const [form, setForm] = useState<ReturnType<typeof blank>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const schedules = profile.schedules ?? [];
  const runs = profile.agents
    .filter((a) => a.scheduleRun)
    .sort((a, b) => b.scheduleRun!.startedAt - a.scheduleRun!.startedAt);
  const ids = [
    ...new Set([
      ...schedules.map((s) => s.scheduleId),
      ...runs.map((a) => a.scheduleRun!.scheduleId),
    ]),
  ];
  function edit(schedule: UserSchedule) {
    setForm({
      scheduleId: schedule.scheduleId,
      name: schedule.name,
      message: schedule.message,
      delay: String(
        Math.max(
          1,
          Math.ceil(
            ((schedule.nextRunAt ?? Date.now() + 300000) - Date.now()) / 1000,
          ),
        ),
      ),
      repeat:
        schedule.repeatEverySeconds === null
          ? ""
          : String(schedule.repeatEverySeconds),
      tools: schedule.tools,
    });
    setError("");
    setNotice("");
  }
  async function remove(schedule: UserSchedule) {
    if (
      !window.confirm(
        `Delete “${schedule.name}”? Future runs will stop. Running agents and past conversations will be kept.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await userClient.cancelSchedule(schedule.scheduleId);
      await refresh();
      setNotice("Schedule deleted. Run conversations were kept.");
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="account-pane schedules-pane">
      <header className="schedules-heading">
        <div>
          <p className="eyebrow">Your workspace</p>
          <h1>Schedules</h1>
        </div>
        <button
          className="button secondary small"
          type="button"
          onClick={() => {
            setForm(blank());
            setError("");
            setNotice("");
          }}
          disabled={busy}
        >
          <Plus size={16} /> New schedule
        </button>
      </header>
      <p>
        Recurring work, fresh conversations. Each run starts its own agent with
        your memories and tools. Overlapping runs are skipped.
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {form && (
        <form
          className="schedule-editor"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            const delaySeconds = Number(form.delay),
              repeatEverySeconds = form.repeat ? Number(form.repeat) : null;
            if (
              ![
                delaySeconds,
                ...(repeatEverySeconds === null ? [] : [repeatEverySeconds]),
              ].every((n) => Number.isInteger(n) && n >= 1 && n <= 31536000)
            ) {
              setError("Delays must be whole seconds between 1 and 31536000.");
              return;
            }
            setBusy(true);
            setError("");
            setNotice("");
            // Retain the ID after a failed/uncertain response so retry replaces rather than duplicates.
            const scheduleId = form.scheduleId || crypto.randomUUID();
            setForm({...form, scheduleId});
            try {
              await userClient.upsertSchedule({
                scheduleId,
                name: form.name.trim(),
                message: form.message.trim(),
                delaySeconds,
                repeatEverySeconds,
                tools: form.tools,
              });
              setForm(undefined);
              await refresh();
              setNotice("Schedule saved.");
            } catch (error) {
              setError(String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="schedules-heading">
            <h2>{form.scheduleId ? "Edit schedule" : "New schedule"}</h2>
            <button
              className="icon-button"
              type="button"
              aria-label="Close schedule editor"
              onClick={() => setForm(undefined)}
              disabled={busy}
            >
              <X />
            </button>
          </div>
          <label>
            Name
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => setForm({...form, name: e.target.value})}
            />
          </label>
          <label>
            Instructions
            <textarea
              required
              maxLength={32000}
              rows={4}
              placeholder="What should each run do? Include everything the new agent needs."
              value={form.message}
              onChange={(e) => setForm({...form, message: e.target.value})}
            />
          </label>
          <div className="form-grid two">
            <label>
              First run in (seconds)
              <input
                required
                type="number"
                min={1}
                max={31536000}
                step={1}
                value={form.delay}
                onChange={(e) => setForm({...form, delay: e.target.value})}
              />
            </label>
            <label>
              Repeat every (seconds)
              <input
                type="number"
                min={1}
                max={31536000}
                step={1}
                placeholder="Leave empty for one run"
                value={form.repeat}
                onChange={(e) => setForm({...form, repeat: e.target.value})}
              />
            </label>
          </div>
          <div className="schedule-presets" aria-label="Repeat presets">
            {[
              ["Once", ""],
              ["Hourly", "3600"],
              ["Daily", "86400"],
              ["Weekly", "604800"],
            ].map(([label, value]) => (
              <button
                type="button"
                className="button ghost small"
                key={label}
                aria-pressed={form.repeat === value}
                onClick={() => setForm({...form, repeat: value})}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="section-copy">
            {form.tools
              ? "This schedule keeps its configured tool restrictions."
              : "Uses the default agent tools and your authorized connectors."}{" "}
            Run conversations and sandbox files are separate; shared memories
            carry across runs.
          </p>
          <button
            className="button secondary"
            type="submit"
            disabled={busy || !form.name.trim() || !form.message.trim()}
          >
            <AlarmClock size={16} />
            {busy ? "Saving…" : "Save schedule"}
          </button>
        </form>
      )}
      {ids.length === 0 && (
        <div className="schedule-empty">
          <AlarmClock size={28} />
          <h2>No schedules yet</h2>
          <p>Create one here, or ask an agent to schedule something for you.</p>
        </div>
      )}
      <div className="user-schedule-list">
        {ids.map((id) => {
          const schedule = schedules.find((s) => s.scheduleId === id);
          const history = runs.filter((a) => a.scheduleRun!.scheduleId === id);
          const hasUnread = history.some((a) => unread.has(a.agentId));
          return (
            <section className="user-schedule-card" key={id}>
              <div className="schedules-heading">
                <div>
                  <h2>
                    {schedule?.name ?? history[0]?.scheduleRun?.scheduleName}
                    {hasUnread && (
                      <span
                        className="schedule-unread"
                        aria-label="New run results"
                      />
                    )}
                  </h2>
                  <small>
                    {schedule
                      ? schedule.repeatEverySeconds === null
                        ? "One-time"
                        : `Every ${duration(schedule.repeatEverySeconds)}`
                      : "Schedule deleted"}
                  </small>
                </div>
                {schedule && (
                  <div className="schedule-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Edit ${schedule.name}`}
                      disabled={busy}
                      onClick={() => edit(schedule)}
                    >
                      <Pencil />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={`Delete schedule ${schedule.name}`}
                      disabled={busy}
                      onClick={() => void remove(schedule)}
                    >
                      <Trash2 />
                    </button>
                  </div>
                )}
              </div>
              {schedule && (
                <>
                  <p className="schedule-instructions">{schedule.message}</p>
                  <p className="section-copy">
                    {schedule.nextRunAt === null ? (
                      "No further runs scheduled"
                    ) : (
                      <>
                        Next run:{" "}
                        <time
                          dateTime={new Date(schedule.nextRunAt).toISOString()}
                        >
                          {new Date(schedule.nextRunAt).toLocaleString()}
                        </time>
                      </>
                    )}
                    {schedule.skippedRuns > 0 &&
                      ` · ${schedule.skippedRuns} overlapping occurrence(s) skipped`}
                  </p>
                  {schedule.lastError && (
                    <p className="inline-error" role="alert">
                      {schedule.lastError}
                    </p>
                  )}
                </>
              )}
              <details className="schedule-runs" open={hasUnread || undefined}>
                <summary>
                  {history.length} run{history.length === 1 ? "" : "s"}
                  {hasUnread ? " · new results" : ""}
                </summary>
                {history.length === 0 && (
                  <p className="empty-copy">The first run will appear here.</p>
                )}
                {history.map((a) => (
                  <div className="schedule-run-row" key={a.agentId}>
                    <button
                      type="button"
                      className="schedule-run-open"
                      onClick={() => onOpenAgent(a.agentId)}
                    >
                      <span aria-hidden="true">🤖</span>
                      <span>
                        <strong>
                          {new Date(a.scheduleRun!.startedAt).toLocaleString()}
                          {unread.has(a.agentId) && (
                            <span className="schedule-unread" />
                          )}
                        </strong>
                        <small>
                          {a.scheduleRun!.status}
                          {a.scheduleRun!.error && ` — ${a.scheduleRun!.error}`}
                        </small>
                      </span>
                      <ArrowRight size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={`Delete run from ${new Date(a.scheduleRun!.startedAt).toLocaleString()}`}
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await onDeleteAgent(a.agentId, a.name);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <Trash2 />
                    </button>
                  </div>
                ))}
              </details>
            </section>
          );
        })}
      </div>
    </main>
  );
}
