// User-owned schedules use Restate delayed invocations, not process timers.
// Only execute() is long-running, and it is a shared handler:
// never hold the User lock while an Agent turn calls back for credentials/memory.
import {createHash} from "node:crypto";
import {
  AgentProfileSchema,
  type AgentProfile,
  type AgentTurnOutcome,
  type UserAgent,
  type UserSchedule,
  type UserScheduleSpec,
} from "@restate-agents/types";
import {
  AgentDefinition,
  UserDefinition,
  UserNotificationsDefinition,
} from "@restate-agents/types/services";
import {rpc, TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

type Stored = {
  schedule: UserSchedule;
  profile: AgentProfile;
  invocationId?: string;
};
const STATE = "user-schedules";

function key() {
  const id = restate.handlerRequest().key;
  if (!id) throw new TerminalError("User key required");
  return id;
}
function* stored(): restate.Operation<Stored[]> {
  return (yield* restate.sharedState().get<Stored[]>(STATE)) ?? [];
}
function* agents(): restate.Operation<UserAgent[]> {
  return (yield* restate.sharedState().get<UserAgent[]>("agents")) ?? [];
}
function* notify(): restate.Operation<void> {
  yield* restate
    .sendClient(UserNotificationsDefinition, key())
    .publish({kind: "profile"});
}
export function* list(): restate.Operation<UserSchedule[]> {
  return (yield* stored()).map((s) => s.schedule);
}
function* scheduleInvocation(scheduleId: string, seconds: number) {
  const nextRunAt = (yield* restate.date().now()) + seconds * 1000;
  const sent = yield* restate
    .sendClient(UserDefinition, key())
    .fireSchedule({scheduleId}, rpc.sendOpts({delay: seconds * 1000}));
  return {invocationId: sent.id, nextRunAt};
}
export function* upsert(
  spec: UserScheduleSpec,
  inherited?: AgentProfile,
): restate.Operation<UserSchedule> {
  if (!(yield* restate.state().get("identity")))
    throw new TerminalError("User is not registered", {errorCode: 404});
  const all = yield* stored();
  const old = all.find((s) => s.schedule.scheduleId === spec.scheduleId);
  if (!old && all.length >= 32)
    throw new TerminalError("Limit of 32 schedules reached", {errorCode: 400});
  if (old?.invocationId) restate.invocation(old.invocationId).cancel();
  const next = yield* scheduleInvocation(spec.scheduleId, spec.delaySeconds);
  const profile =
    inherited ??
    AgentProfileSchema.parse({
      guardrails: [],
      ...old?.profile,
      ...(spec.tools ? {tools: spec.tools} : {}),
    });
  const schedule: UserSchedule = {
    scheduleId: spec.scheduleId,
    name: spec.name,
    message: spec.message,
    repeatEverySeconds: spec.repeatEverySeconds,
    tools: inherited?.tools ?? spec.tools,
    nextRunAt: next.nextRunAt,
    skippedRuns: old?.schedule.skippedRuns ?? 0,
  };
  const entry = {schedule, profile, invocationId: next.invocationId};
  restate.state().set(STATE, [...all.filter((s) => s !== old), entry]);
  // Active runs are independent of the schedule definition: replacing or
  // deleting/recreating a schedule must not defeat overlap prevention.
  yield* notify();
  return schedule;
}
export function* cancel(scheduleId: string): restate.Operation<boolean> {
  const all = yield* stored();
  const old = all.find((s) => s.schedule.scheduleId === scheduleId);
  if (!old) return false;
  if (old.invocationId) restate.invocation(old.invocationId).cancel();
  restate.state().set(
    STATE,
    all.filter((s) => s !== old),
  );
  yield* notify();
  return true;
}
export function* fire(scheduleId: string): restate.Operation<void> {
  const all = yield* stored();
  const entry = all.find((s) => s.schedule.scheduleId === scheduleId);
  if (
    !entry?.invocationId ||
    entry.invocationId !== restate.handlerRequest().id
  )
    return;
  const {schedule} = entry;
  const occurrenceId = entry.invocationId;
  if (schedule.repeatEverySeconds !== null) {
    const next = yield* scheduleInvocation(
      scheduleId,
      schedule.repeatEverySeconds,
    );
    entry.invocationId = next.invocationId;
    schedule.nextRunAt = next.nextRunAt;
  } else {
    delete entry.invocationId;
    schedule.nextRunAt = null;
  }
  delete schedule.lastError;
  const activeRuns =
    (yield* restate.state().get<Record<string, string>>("schedule-active")) ??
    {};
  const active = Object.hasOwn(activeRuns, scheduleId)
    ? activeRuns[scheduleId]
    : undefined;
  const directory = yield* agents();
  if (active) schedule.skippedRuns++;
  else {
    // Stable per durable occurrence, including retries/replays.
    const agentId = createHash("sha256")
      .update(JSON.stringify(["schedule-run", key(), scheduleId, occurrenceId]))
      .digest("hex");
    const startedAt = yield* restate.date().now();
    const agent: UserAgent = {
      agentId,
      name: schedule.name,
      scheduleRun: {
        scheduleId,
        scheduleName: schedule.name,
        startedAt,
        status: "running",
      },
    };
    // initialize does not call User. Execution below is a separate invocation.
    yield* restate.client(AgentDefinition, agentId).initialize({
      ownerUserId: key(),
      name: agent.name,
      profile: entry.profile,
      scheduledMessage: schedule.message,
    });
    restate.state().set("agents", [...directory, agent]);
    restate
      .state()
      .set("schedule-active", {...activeRuns, [scheduleId]: agentId});
    yield* restate.sendClient(UserDefinition, key()).executeSchedule({agentId});
  }
  restate.state().set(STATE, all);
  yield* notify();
}
export function* execute(agentId: string): restate.Operation<void> {
  const agent = (yield* agents()).find((a) => a.agentId === agentId);
  if (!agent) {
    yield* restate.client(UserDefinition, key()).finishSchedule({
      agentId,
      status: "interrupted",
      error: "Run conversation deleted before startup",
    });
    return;
  }
  if (!agent.scheduleRun || agent.scheduleRun.status !== "running") return;
  let status: NonNullable<UserAgent["scheduleRun"]>["status"] = "failed";
  let error: string | undefined;
  try {
    const started = yield* restate
      .client(AgentDefinition, agentId)
      .startScheduledTurn({ownerUserId: key()});
    const outcome = yield* restate
      .invocation<AgentTurnOutcome>(started.turnId)
      .attach();
    status = outcome.status;
    if (outcome.status === "failed") error = outcome.error;
  } catch (failure) {
    if (!(failure instanceof TerminalError)) throw failure;
    error = failure.message;
  } finally {
    yield* restate
      .client(UserDefinition, key())
      .finishSchedule({agentId, status, ...(error ? {error} : {})});
  }
}
export function* finish(
  agentId: string,
  status: NonNullable<UserAgent["scheduleRun"]>["status"],
  error?: string,
): restate.Operation<void> {
  const directory = yield* agents();
  const agent = directory.find((a) => a.agentId === agentId);
  // Delete may have removed the directory entry while execution was stopping.
  const active =
    (yield* restate.state().get<Record<string, string>>("schedule-active")) ??
    {};
  restate
    .state()
    .set(
      "schedule-active",
      Object.fromEntries(
        Object.entries(active).filter(([, id]) => id !== agentId),
      ),
    );
  if (agent?.scheduleRun?.status === "running") {
    agent.scheduleRun = {
      ...agent.scheduleRun,
      status,
      finishedAt: yield* restate.date().now(),
      ...(error ? {error} : {}),
    };
    restate.state().set("agents", directory);
  }
  yield* notify();
}
