# Per-agent schedules

`AgentScheduler/{agentId}` owns a small registry of delayed messages. Each
occurrence delivers back to **the same conversation**, through `Agent.deliver`.
A schedule persists independently of the turn that created it. There is no
account scheduler or fresh agent per occurrence.

## Contract

```sh
curl localhost:8080/AgentScheduler/demo/upsert --json '{
  "scheduleId":"reminder",
  "message":"Remind me to check the build",
  "delaySeconds":60,
  "repeatEverySeconds":null,
  "whenBusy":"queue"
}'
curl -X POST localhost:8080/AgentScheduler/demo/list
curl localhost:8080/AgentScheduler/demo/cancel \
  --json '{"scheduleId":"reminder"}'
```

`upsert` creates or replaces a named schedule; the registry holds at most 32.
`repeatEverySeconds: null` means one shot. A positive interval rearms the next
delayed invocation when the current timer fires; this is interval scheduling,
not a calendar/cron rule or a catch-up ledger. Exact input bounds live in
`ScheduleSpecSchema`.

The model tools `createSchedule`, `listSchedules`, and `cancelSchedule` use the
same registry. The UI lists and cancels schedules. `upsert` checks Agent
metadata even for direct operator calls: children cannot create schedules,
because only their parent can initiate their turns.

## Routing and lifecycle

A valid timer advances or removes its schedule, publishes the `schedules`
notification topic, and calls `Agent.deliver`. An idle Agent starts a turn.
When busy, the saved policy selects:

| Policy | Behavior |
| --- | --- |
| `queue` | Preserve active work and append the message to pending FIFO input |
| `steer` | Feed the active turn through ordered steering signals |
| `interrupt` | Stop the current turn and queue the delivered replacement |

Timer identity is stored with each schedule. Replaced or cancelled timer
invocations cannot deliver if their invocation ID no longer matches. Cancelling
is idempotent; it prevents future delivery but does not retract a message
already delivered. Retiring an Agent sends one-way retirement to its scheduler,
which cancels timers, clears the registry and refuses new schedules.

The scheduler sends `deliver` one-way rather than waiting on it, so its lock is
never held behind the Agent's queue and a cancel is never stuck behind a
delivery. Turn execution happens on AgentSession after routing.

Focused tests cover stale timers, recurrence, retirement and delivery identity.
The live `scheduling` eval checks one-shot wakeup and event ordering.
