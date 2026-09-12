# User-owned schedules

Schedules belong to the user, not to an existing agent. Manage them in the
**Schedules** screen or ask an agent to create one. Each occurrence creates a
fresh, normal agent conversation with a separate lazy sandbox. User memories
are loaded at turn start; previous run transcripts and files are not copied.

## Durable lifecycle

`User.upsertSchedule` stores the definition and sends a delayed Restate call to
`User.fireSchedule` on the same user key. There are no process timers or cron
workers. The stored invocation ID rejects stale or cancelled deliveries.
Replacing or deleting a schedule cancels its pending delayed invocation.

On a valid occurrence, `fireSchedule` installs the next delayed call, if any.
If that schedule already has an active run, this occurrence is skipped, not
queued. Otherwise it initializes a new owned agent, records run metadata in
the user's directory, and sends `User.executeSchedule`. The agent ID is derived
from the user, schedule ID, and occurrence invocation ID, so retries reuse it.

`executeSchedule` is a **shared** handler. It starts the initial turn through
`Agent.startScheduledTurn` and attaches to the returned `doTurn` invocation.
It never holds the User's exclusive lock while waiting for a turn. The normal
turn lifecycle releases sandbox leases. `User.finishSchedule` records the
outcome and clears only that run's active marker, allowing future occurrences.

One-shot definitions remain visible with `nextRunAt: null`. Fixed intervals
are relative to processing the previous occurrence; calendar/cron/time-zone
scheduling is not implemented.

## Tools and authorization

- `createSchedule` accepts a stable `scheduleId`, `name`, self-contained
  `message`, `delaySeconds`, nullable `repeatEverySeconds`, and nullable `tools`.
  Use only when the user requests future or recurring work.
- `Agent.createSchedule` verifies the current non-interrupting turn and its
  tool grant, then derives the immutable owning user. It snapshots instructions,
  guardrails, web-search settings, and current tool access. Explicit selections
  can only narrow access. Connector grants are pinned; credentials are never
  copied into the schedule. Future turns use the owner's current credentials.
- `listSchedules` lists the same user's definitions; `cancelSchedule` deletes
  a definition and stops future occurrences only.
- The BFF exposes `POST /api/user/schedule` and `/api/user/cancel-schedule`,
  guarded by the existing authenticated session and same-origin checks. The
  user key is derived from the session, never from request JSON. Internal
  start/finish/fire handlers are not exposed through the BFF.

Schedules created directly by the user use ordinary default agent permissions
unless explicit tool restrictions are supplied. UI edits preserve restrictions
and inherited policies. Schedule changes and run outcomes publish the User's
profile notification; the existing workspace sync updates the cached screen.
No per-agent schedule RPC or extra browser polling loop is needed.

## Conversations and cleanup

Runs are grouped by schedule, with status, unread results, and a link to each
conversation. Opening a run allows normal follow-up messages and interruption.
Its initial scheduled task alone determines the recorded run outcome; later
follow-up turns do not block future scheduled occurrences.

- Deleting a schedule leaves active runs and completed conversations intact.
- Deleting a run uses normal cascading agent deletion, stops its work, and
  removes its sandbox resources. It does not delete the user schedule.
- Deleting the agent that created a schedule does not delete the schedule.
- Replacing or deleting/recreating a schedule does not bypass overlap checks.

There is a limit of 32 schedule definitions, but no fixed agent-count cap.
Old run conversations are not automatically deleted. The former per-agent `AgentScheduler` service and
`scheduleMessage` tool are removed; old schedule state is not migrated. Deploy
the core service and BFF together, with old delayed work drained/cancelled or
fresh development state before upgrading.
