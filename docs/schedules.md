# Per-agent schedules

Each Agent owns a small registry of delayed messages. Each occurrence delivers
back to **the same conversation**, through the same routing as
`Agent.deliver`. A schedule persists independently of the turn that created
it. There is no account scheduler or fresh agent per occurrence.

## Contract

```sh
curl localhost:8080/Agent/demo/createSchedule --json '{
  "scheduleId":"reminder",
  "message":"Remind me to check the build",
  "delaySeconds":60,
  "repeatEverySeconds":null,
  "whenBusy":"queue"
}'
curl -X POST localhost:8080/Agent/demo/schedules
curl localhost:8080/Agent/demo/cancelSchedule \
  --json '{"scheduleId":"reminder"}'
```

`createSchedule` creates or replaces a named schedule; the registry holds at
most 32. `repeatEverySeconds: null` means one shot. A positive interval rearms
the next delayed invocation when the current timer fires; this is interval
scheduling, not a calendar/cron rule or a catch-up ledger. Exact input bounds
live in `ScheduleSpecSchema`.

The model tools `createSchedule`, `listSchedules`, and `cancelSchedule` use the
same handlers. The tools pass their `turnId`, so Agent rejects a stale or
interrupting turn and a turn whose grant omits the tool; an in-flight call
cannot outlive an interrupt. The UI and direct callers omit `turnId`. Children
cannot create schedules, even when called directly, because only their parent
can initiate their turns.

## Routing and lifecycle

Each schedule stores the invocation ID of its next delayed `Agent.fire`. A
valid firing advances or removes its schedule, publishes the `schedules`
notification topic, and routes the message. An idle Agent starts a turn. When
busy, the saved policy selects:

| Policy | Behavior |
| --- | --- |
| `queue` | Preserve active work and append the message to pending FIFO input |
| `steer` | Feed the active turn through ordered steering signals |
| `interrupt` | Stop the current turn and queue the delivered replacement |

Scheduled deliveries coalesce: while an earlier delivery from the same
`scheduleId` is still queued, or is part of the active turn, a later firing is
dropped instead of routed. A recurring schedule that fires faster than the
agent works therefore keeps at most one pending run, and an `interrupt`
schedule never interrupts the turn it started itself. The recurrence keeps its
cadence; skipped firings are not caught up.

Replaced or cancelled timer invocations cannot deliver, because their
invocation ID no longer matches. Firing and cancellation share the Agent's
exclusive lock, so a cancel either lands before a firing (which is then stale)
or after its delivery. Cancelling is idempotent; it prevents future delivery
but does not retract a message already delivered. Retiring an Agent cancels
its timers and clears the registry, and a retired Agent refuses new schedules.
Turn execution happens on AgentSession after routing.

Focused tests cover stale timers, recurrence, retirement and delivery identity.
