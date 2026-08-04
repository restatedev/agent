// Durable black-box evaluations for the Agent protocol. One Evals handler
// concurrently drives fresh Agents through their public handlers, observes
// their canonical transcripts through history awakeables, and returns
// structured assertions rather than relying on exact model prose.

import {type HistoryPage, HistoryPageSchema} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";
import {z} from "zod";
import {Agent} from "./agent.js";
import {AgentSession} from "./agent-session.js";
import {callContextReducer} from "./model-gateway.js";
import {raceBranches} from "./race.js";

const EvalCaseIdSchema = z.enum([
  "basic-turn",
  "steering",
  "interruption",
  "external-cancellation",
  "interruption-replacement",
  "execution-limit",
  "context-reduction",
  "memory",
  "scheduling",
  "guardrail-approval",
  "guardrail-scope",
  "guardrail-denial",
  "guardrail-rejection",
  "guardrail-removal",
  "guardrail-steering",
]);
type EvalCaseId = z.infer<typeof EvalCaseIdSchema>;

const EvalOptionsSchema = z.object({
  runId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional suite run identifier. Omit it to isolate this run by its invocation ID.",
    ),
  attempt: z.number().int().positive().default(1),
  timeoutSeconds: z.number().int().min(10).max(600).default(120),
  cases: z
    .array(EvalCaseIdSchema)
    .min(1)
    .optional()
    .describe(
      "Optional subset of cases to run. Omit to run the complete suite. A subset keeps each case's isolation and assertions identical, so one probabilistic case can be re-run without paying for the others.",
    ),
});
type EvalOptions = z.infer<typeof EvalOptionsSchema>;

const EvalAssertionSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  details: z.string().optional(),
});
type EvalAssertion = z.infer<typeof EvalAssertionSchema>;

const EvalResultSchema = z.object({
  caseId: EvalCaseIdSchema,
  agentId: z.string(),
  status: z.enum(["passed", "failed"]),
  assertions: z.array(EvalAssertionSchema),
  transcript: HistoryPageSchema.shape.entries,
});
type EvalResult = z.infer<typeof EvalResultSchema>;

const EvalSuiteResultSchema = z.object({
  status: z.enum(["passed", "failed"]),
  results: z.array(EvalResultSchema),
});
type EvalSuiteResult = z.infer<typeof EvalSuiteResultSchema>;

type SequencedEntry = HistoryPage["entries"][number];
type EntryPredicate = (candidate: SequencedEntry) => boolean;

type HistoryReader = {
  agentId: string;
  nextSequence: number;
  notificationRevision: number;
  entries: SequencedEntry[];
  deadline: restate.Future<void>;
};

type EvalContext = {
  agentId: string;
  history: HistoryReader;
};

class EvalTimeout extends Error {}
class EvalScenarioFailure extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertion(
  name: string,
  passed: boolean,
  details?: string,
): EvalAssertion {
  return {name, passed, ...(details ? {details} : {})};
}

function requireStarted(result: {
  decision: "start" | "queue";
  turnId: string | null;
}): asserts result is {decision: "start"; turnId: string} {
  if (result.decision !== "start" || result.turnId === null) {
    throw new EvalScenarioFailure(
      "a fresh evaluation Agent unexpectedly queued its first request",
    );
  }
}

function* readAvailable(reader: HistoryReader): restate.Operation<void> {
  while (true) {
    const page = yield* restate
      .client(AgentSession, reader.agentId)
      .history({fromSequence: reader.nextSequence, limit: 100});
    if (page.entries.length === 0) {
      return;
    }
    reader.entries.push(...page.entries);
    reader.nextSequence = page.nextSequence;
  }
}

function* waitForHistory(
  reader: HistoryReader,
  description: string,
  predicate: EntryPredicate,
): restate.Operation<SequencedEntry> {
  while (true) {
    yield* readAvailable(reader);
    const found = reader.entries.find(predicate);
    if (found) {
      return found;
    }

    // Agent owns and resolves the durable notification subscription. History
    // remains an authoritative read from AgentSession.
    const watch = restate.client(Agent, reader.agentId).watchNotifications({
      afterRevision: reader.notificationRevision,
      timeoutSeconds: 30,
    });
    const selected = yield* raceBranches({
      watch,
      deadline: reader.deadline,
    });
    if (selected.tag === "deadline") {
      throw new EvalTimeout(`timed out waiting for ${description}`);
    }
    const notification = selected.value;
    reader.notificationRevision = notification.revision;
  }
}

function* waitForTurnMilestone(
  reader: HistoryReader,
  turnId: string,
  description: string,
  predicate: EntryPredicate,
): restate.Operation<SequencedEntry> {
  const found = yield* waitForHistory(
    reader,
    description,
    (candidate) => predicate(candidate) || isTerminalFor(turnId)(candidate),
  );
  if (isTerminalFor(turnId)(found) && !predicate(found)) {
    const entry = found.entry;
    const status = entry.role === "assistant" ? entry.status : "unknown";
    throw new EvalScenarioFailure(
      `turn ${turnId} ended with status ${status} before ${description}`,
    );
  }
  return found;
}

function isTerminalFor(turnId: string): EntryPredicate {
  return ({entry}) => entry.role === "assistant" && entry.turnId === turnId;
}

function isWaitingForPendingOperation(turnId: string): EntryPredicate {
  return ({entry}) =>
    entry.role === "event" &&
    entry.type === "progress" &&
    entry.turnId === turnId &&
    entry.phase === "waiting" &&
    entry.message.includes("pending operation");
}

function isWaitingForGuardrail(
  turnId: string,
  guardrailId: string,
  afterSequence = 0,
): EntryPredicate {
  return ({sequence, entry}) =>
    sequence > afterSequence &&
    entry.role === "event" &&
    entry.type === "approval_request" &&
    entry.turnId === turnId &&
    entry.guardrailId === guardrailId;
}

function isWaitingForApproval(turnId: string): EntryPredicate {
  return ({entry}) =>
    entry.role === "event" &&
    entry.type === "approval_request" &&
    entry.turnId === turnId;
}

function guardrailApprovalEvents(
  history: HistoryReader,
  turnId: string,
  guardrailId: string,
): SequencedEntry[] {
  return history.entries.filter(isWaitingForGuardrail(turnId, guardrailId));
}

function protectedWeatherRan(history: HistoryReader, turnId: string): boolean {
  return toolStartCount(history, turnId, "getWeather") > 0;
}

function toolStartCount(
  history: HistoryReader,
  turnId: string,
  toolName: string,
): number {
  return history.entries
    .flatMap(({entry}) => {
      if (
        entry.role !== "event" ||
        entry.type !== "tools" ||
        entry.turnId !== turnId ||
        entry.phase !== "started"
      ) {
        return [];
      }
      return entry.calls.map(({name}) => name);
    })
    .filter((started) => started === toolName).length;
}

function* basicTurn({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  const ask = yield* restate.client(Agent, agentId).ask({
    message:
      "Use the weather tool to get the current weather in Berlin, then answer with the city and conditions.",
  });
  requireStarted(ask);
  const terminal = yield* waitForHistory(
    history,
    "the basic turn to finish",
    isTerminalFor(ask.turnId),
  );
  const response =
    terminal.entry.role === "assistant" ? terminal.entry.text : "";
  const terminalEntries = history.entries.filter(
    ({entry}) => entry.role === "assistant" && entry.turnId === ask.turnId,
  );

  return [
    assertion(
      "ask starts an idle Agent",
      ask.decision === "start",
      `decision was ${ask.decision}`,
    ),
    assertion(
      "the turn completes successfully",
      terminal.entry.role === "assistant" &&
        terminal.entry.status === "completed",
    ),
    assertion(
      "the turn has exactly one terminal transcript entry",
      terminalEntries.length === 1,
      `found ${terminalEntries.length}`,
    ),
    assertion(
      "the response identifies Berlin",
      response.toLowerCase().includes("berlin"),
    ),
  ];
}

function* scheduling({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  const pending = yield* restate.client(Agent, agentId).scheduleMessage({
    turnId: null,
    schedule: {
      scheduleId: "cancelled-reminder",
      message: "This message must never be delivered.",
      delaySeconds: 60,
      repeatEverySeconds: null,
      whenBusy: "queue",
    },
  });
  const beforeCancel = yield* restate.client(Agent, agentId).schedules();
  const cancellation = yield* restate.client(Agent, agentId).cancelSchedule({
    turnId: null,
    scheduleId: "cancelled-reminder",
  });
  const afterCancel = yield* restate.client(Agent, agentId).schedules();

  const scheduled = yield* restate.client(Agent, agentId).scheduleMessage({
    turnId: null,
    schedule: {
      scheduleId: "one-shot",
      message:
        "Reply briefly that the scheduled delivery was received. Do not call tools.",
      delaySeconds: 1,
      repeatEverySeconds: null,
      whenBusy: "queue",
    },
  });
  const fired = yield* waitForHistory(
    history,
    "the one-shot schedule to fire",
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "schedule" &&
      entry.scheduleId === "one-shot" &&
      entry.action === "fired",
  );
  const terminal = yield* waitForHistory(
    history,
    "the scheduled turn to finish",
    ({sequence, entry}) =>
      sequence > fired.sequence && entry.role === "assistant",
  );
  const remaining = yield* restate.client(Agent, agentId).schedules();
  const delivered = history.entries.find(
    ({sequence, entry}) =>
      sequence === fired.sequence + 1 &&
      entry.role === "user" &&
      entry.text.includes("scheduled delivery was received"),
  );

  return [
    assertion(
      "a schedule can be created and listed",
      pending.accepted &&
        beforeCancel.some(
          ({scheduleId}) => scheduleId === "cancelled-reminder",
        ),
    ),
    assertion(
      "cancellation removes the durable schedule",
      cancellation.accepted &&
        cancellation.cancelled &&
        !afterCancel.some(
          ({scheduleId}) => scheduleId === "cancelled-reminder",
        ),
    ),
    assertion("a one-shot schedule is accepted", scheduled.accepted),
    assertion(
      "an idle scheduled delivery starts a turn",
      fired.entry.role === "event" &&
        fired.entry.type === "schedule" &&
        fired.entry.routing === "start",
    ),
    assertion(
      "the due message immediately follows its firing event",
      delivered !== undefined,
    ),
    assertion(
      "the scheduled turn completes",
      terminal.entry.role === "assistant" &&
        terminal.entry.status === "completed",
    ),
    assertion(
      "the one-shot schedule is removed before delivery",
      !remaining.some(({scheduleId}) => scheduleId === "one-shot"),
    ),
  ];
}

function* steering({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  const ask = yield* restate.client(Agent, agentId).ask({
    message:
      "Get the weather in Berlin and start a durable 8-second sleep. Keep the sleep running until it completes, and only then answer.",
  });
  requireStarted(ask);
  yield* waitForTurnMilestone(
    history,
    ask.turnId,
    "the sleep operation to become pending",
    isWaitingForPendingOperation(ask.turnId),
  );

  const accepted = yield* restate
    .client(Agent, agentId)
    .steer("Also get the weather in Paris. Keep the existing sleep running.");
  const terminal = yield* waitForHistory(
    history,
    "the steered turn to finish",
    isTerminalFor(ask.turnId),
  );
  const response =
    terminal.entry.role === "assistant"
      ? terminal.entry.text.toLowerCase()
      : "";
  const steerEntry = history.entries.find(
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "steer" &&
      entry.turnId === ask.turnId,
  );
  const sleepStarts = toolStartCount(history, ask.turnId, "sleep");

  return [
    assertion("steering is accepted", accepted),
    assertion("steering stays in the original turn", steerEntry !== undefined),
    assertion(
      "the steering event precedes the terminal response",
      steerEntry !== undefined && steerEntry.sequence < terminal.sequence,
    ),
    assertion(
      "the steered turn completes rather than being interrupted",
      terminal.entry.role === "assistant" &&
        terminal.entry.status === "completed",
    ),
    assertion(
      "the final response retains Berlin and incorporates Paris",
      response.includes("berlin") && response.includes("paris"),
    ),
    assertion(
      "steering does not restart the pending sleep",
      sleepStarts === 1,
      `found ${sleepStarts} sleep tool calls`,
    ),
  ];
}

function* interruption({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  const ask = yield* restate.client(Agent, agentId).ask({
    message:
      "Get the weather in Berlin and start a durable 30-second sleep. Keep the sleep running until it completes, and only then answer.",
  });
  requireStarted(ask);
  yield* waitForTurnMilestone(
    history,
    ask.turnId,
    "the sleep operation to become pending",
    isWaitingForPendingOperation(ask.turnId),
  );

  const accepted = yield* restate.client(Agent, agentId).interrupt({
    reason: "Stop the sleep and summarize the completed weather work.",
  });
  const terminal = yield* waitForHistory(
    history,
    "the interrupted turn to finish",
    isTerminalFor(ask.turnId),
  );
  const interruptEntry = history.entries.find(
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "interrupt" &&
      entry.turnId === ask.turnId,
  );
  const finalizing = history.entries.find(
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "progress" &&
      entry.turnId === ask.turnId &&
      entry.phase === "finalizing",
  );
  const cancelledSleep = history.entries.find(
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "tools" &&
      entry.turnId === ask.turnId &&
      entry.phase === "finished" &&
      entry.calls.some(
        ({name, status}) => name === "sleep" && status === "cancelled",
      ),
  );

  return [
    assertion("interruption is accepted", accepted),
    assertion(
      "the interruption is recorded before the terminal response",
      interruptEntry !== undefined &&
        interruptEntry.sequence < terminal.sequence,
    ),
    assertion(
      "the Turn reports graceful finalization",
      finalizing !== undefined && finalizing.sequence < terminal.sequence,
    ),
    assertion(
      "the terminal response is marked interrupted",
      terminal.entry.role === "assistant" &&
        terminal.entry.status === "interrupted",
    ),
    assertion(
      "the interrupted pending sleep is recorded as cancelled",
      cancelledSleep !== undefined,
    ),
    assertion(
      "completed Berlin work remains available to finalization",
      terminal.entry.role === "assistant" &&
        terminal.entry.text.toLowerCase().includes("berlin"),
    ),
  ];
}

function* externalCancellation({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  const ask = yield* restate.client(Agent, agentId).ask({
    message:
      "Start a durable 3-minute sleep. Keep it running until it completes, and only then answer.",
  });
  requireStarted(ask);
  yield* waitForTurnMilestone(
    history,
    ask.turnId,
    "the sleep operation to become pending",
    isWaitingForPendingOperation(ask.turnId),
  );

  restate.invocation(ask.turnId).cancel();
  const boundary = yield* waitForHistory(
    history,
    "the external cancellation boundary",
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "interrupt" &&
      entry.turnId === ask.turnId,
  );

  const recovery = yield* restate.client(Agent, agentId).ask({
    message: "Reply briefly that the Agent accepted work after cancellation.",
  });
  requireStarted(recovery);
  const recoveryTerminal = yield* waitForHistory(
    history,
    "the post-cancellation turn to finish",
    isTerminalFor(recovery.turnId),
  );
  const cancelledAssistant = history.entries.find(
    ({entry}) => entry.role === "assistant" && entry.turnId === ask.turnId,
  );

  return [
    assertion(
      "the cancelled Turn had one pending sleep",
      toolStartCount(history, ask.turnId, "sleep") === 1,
    ),
    assertion(
      "external cancellation records an interruption boundary",
      boundary.entry.role === "event" &&
        boundary.entry.type === "interrupt" &&
        boundary.entry.reason === "Turn cancelled",
    ),
    assertion(
      "external cancellation skips graceful assistant finalization",
      cancelledAssistant === undefined,
    ),
    assertion(
      "the Agent accepts a new Turn after cancellation cleanup",
      recovery.decision === "start" && recovery.turnId !== ask.turnId,
    ),
    assertion(
      "the post-cancellation Turn completes",
      recoveryTerminal.entry.role === "assistant" &&
        recoveryTerminal.entry.status === "completed",
    ),
  ];
}

// Interruption may carry a replacement request. Agent holds it until the old
// run finalizes; the successor AgentSession then appends the queued message and
// its dispatch boundary before executing it.
function* interruptionReplacement({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  const ask = yield* restate.client(Agent, agentId).ask({
    message:
      "Get the weather in Berlin and start a durable 60-second sleep. Keep the sleep running until it completes, and only then answer.",
  });
  requireStarted(ask);
  yield* waitForTurnMilestone(
    history,
    ask.turnId,
    "the sleep operation to become pending",
    isWaitingForPendingOperation(ask.turnId),
  );

  const accepted = yield* restate.client(Agent, agentId).interrupt({
    reason: "Stop the sleep and summarize the completed weather work.",
    message: "Never mind that. What is the current weather in Paris?",
  });
  const firstTerminal = yield* waitForHistory(
    history,
    "the interrupted turn to finish",
    isTerminalFor(ask.turnId),
  );
  const replacement = history.entries.find(
    ({entry}) =>
      entry.role === "user" &&
      entry.delivery === "queued" &&
      entry.text.toLowerCase().includes("paris"),
  );
  const interruptEntry = history.entries.find(
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "interrupt" &&
      entry.turnId === ask.turnId,
  );
  const dispatch = yield* waitForHistory(
    history,
    "the queued replacement to be dispatched into a new turn",
    ({entry}) => entry.role === "event" && entry.type === "dispatch",
  );
  const secondTerminal = yield* waitForHistory(
    history,
    "the replacement turn to finish",
    ({sequence, entry}) =>
      entry.role === "assistant" &&
      entry.turnId !== ask.turnId &&
      sequence > dispatch.sequence,
  );
  const secondResponse =
    secondTerminal.entry.role === "assistant"
      ? secondTerminal.entry.text.toLowerCase()
      : "";

  return [
    assertion("interruption with a replacement message is accepted", accepted),
    assertion(
      "the replacement is recorded as a queued user message",
      replacement !== undefined,
    ),
    assertion(
      "the replacement is recorded after the interrupted turn finishes",
      replacement !== undefined &&
        interruptEntry !== undefined &&
        interruptEntry.sequence < firstTerminal.sequence &&
        firstTerminal.sequence < replacement.sequence,
    ),
    assertion(
      "the replacement is appended immediately before its dispatch boundary",
      firstTerminal.entry.role === "assistant" &&
        firstTerminal.entry.status === "interrupted" &&
        replacement !== undefined &&
        replacement.sequence + 1 === dispatch.sequence,
    ),
    assertion(
      "the dispatch boundary activates exactly one queued message",
      dispatch.entry.role === "event" &&
        dispatch.entry.type === "dispatch" &&
        dispatch.entry.queuedMessages === 1,
      dispatch.entry.role === "event" && dispatch.entry.type === "dispatch"
        ? `activated ${dispatch.entry.queuedMessages}`
        : "no dispatch boundary",
    ),
    assertion(
      "a new turn answers the replacement request",
      secondResponse.includes("paris"),
    ),
  ];
}

// Reaching an execution budget must stop the Turn through the guarded,
// tool-free finalization path rather than publishing an internal budget error
// as a failed assistant answer.
function* executionLimit({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  // More cities than the 24-tool-call budget in turn.ts, requested in small
  // batches so some weather work completes before the budget is refused.
  const cities = [
    "Lisbon",
    "Madrid",
    "Dublin",
    "Oslo",
    "Helsinki",
    "Riga",
    "Vilnius",
    "Tallinn",
    "Sofia",
    "Bucharest",
    "Zagreb",
    "Ljubljana",
    "Bratislava",
    "Budapest",
    "Valletta",
    "Nicosia",
    "Reykjavik",
    "Bern",
    "Vaduz",
    "Monaco",
    "Andorra la Vella",
    "San Marino",
    "Luxembourg",
    "Brussels",
    "Amsterdam",
    "Copenhagen",
    "Stockholm",
    "Warsaw",
  ];
  const ask = yield* restate.client(Agent, agentId).ask({
    message: `Report the current weather in each of these ${cities.length} cities: ${cities.join(", ")}. Call the weather tool for at most five cities per response.`,
  });
  requireStarted(ask);
  const terminal = yield* waitForHistory(
    history,
    "the budget-limited turn to finish",
    isTerminalFor(ask.turnId),
  );
  const response =
    terminal.entry.role === "assistant"
      ? terminal.entry.text.toLowerCase()
      : "";
  const limitBoundary = history.entries.find(
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "stop" &&
      entry.turnId === ask.turnId &&
      entry.cause === "tool_limit" &&
      entry.reason.toLowerCase().includes("limit"),
  );
  const finalizing = history.entries.find(
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "progress" &&
      entry.turnId === ask.turnId &&
      entry.phase === "finalizing",
  );
  const weatherCalls = toolStartCount(history, ask.turnId, "getWeather");
  const reportedCities = cities.filter((city) =>
    response.includes(city.toLowerCase()),
  ).length;

  return [
    assertion(
      "the turn stops with a runtime-limit outcome rather than a failure",
      terminal.entry.role === "assistant" &&
        terminal.entry.status === "stopped",
      terminal.entry.role === "assistant"
        ? `status was ${terminal.entry.status}`
        : "no terminal entry",
    ),
    assertion(
      "the runtime records an execution-limit boundary",
      limitBoundary !== undefined && limitBoundary.sequence < terminal.sequence,
    ),
    assertion(
      "the Turn reports finalization before answering",
      finalizing !== undefined && finalizing.sequence < terminal.sequence,
    ),
    assertion(
      "the tool-call budget is enforced",
      weatherCalls > 0 && weatherCalls <= 24,
      `${weatherCalls} getWeather calls started`,
    ),
    assertion(
      "every completed weather result survives into the final answer",
      reportedCities >= weatherCalls,
      `${reportedCities} cities reported for ${weatherCalls} completed calls`,
    ),
  ];
}

// Exercise the lossy boundary directly with one cheap model call. A large
// end-to-end Turn would spend several agent-model rounds merely to cross the
// character threshold; Turn's deterministic prefix selection does not need
// that repeated coverage.
function* contextReduction({
  agentId,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  const completedMarker = "COMPLETED_BERLIN_7319";
  const failedMarker = "FAILED_PARIS_8426";
  const pendingMarker = "PENDING_SLEEP_9537";
  const messages: ModelMessage[] = [
    {
      role: "user",
      content:
        "[Steering update] Get the weather in Berlin and Paris, then keep the existing sleep running.",
    },
    {
      role: "user",
      content: `[Runtime event] Pending tool getWeather (weather-berlin) completed successfully: 22°C, sunny in Berlin. Verification marker: ${completedMarker}`,
    },
    {
      role: "user",
      content: `[Runtime event] Pending tool getWeather (weather-paris) failed: provider unavailable. Verification marker: ${failedMarker}`,
    },
    {
      role: "user",
      content: `[Runtime event] Pending tool sleep (${pendingMarker}) is still running and unresolved.`,
    },
  ];

  const {summary} = yield* callContextReducer({agentId, messages});
  const normalized = summary.toLowerCase();
  return [
    assertion(
      "completed tool results survive context reduction",
      summary.includes(completedMarker) &&
        normalized.includes("berlin") &&
        normalized.includes("22"),
    ),
    assertion(
      "failed tool results survive context reduction",
      summary.includes(failedMarker) &&
        normalized.includes("paris") &&
        normalized.includes("fail"),
    ),
    assertion(
      "unresolved work remains distinguishable after context reduction",
      summary.includes(pendingMarker) &&
        (normalized.includes("pending") || normalized.includes("unresolved")),
    ),
  ];
}

// The model manages durable memory through one atomic Agent handler. The keys
// it changes become a metadata-only transcript event.
function* memory({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  const ask = yield* restate.client(Agent, agentId).ask({
    message:
      "Remember for future conversations that I always want temperatures reported in Fahrenheit. Confirm once you have stored it.",
  });
  requireStarted(ask);
  const terminal = yield* waitForHistory(
    history,
    "the memory turn to finish",
    isTerminalFor(ask.turnId),
  );
  const memoryEvent = history.entries.find(
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "memory" &&
      entry.turnId === ask.turnId,
  );
  const profile = yield* restate.client(Agent, agentId).profile();
  const stored = profile.memories.some(({key, content}) =>
    `${key} ${content}`.toLowerCase().includes("fahrenheit"),
  );

  return [
    assertion(
      "the memory turn completes",
      terminal.entry.role === "assistant" &&
        terminal.entry.status === "completed",
    ),
    assertion(
      "a memory event records the changed keys",
      memoryEvent !== undefined &&
        memoryEvent.entry.role === "event" &&
        memoryEvent.entry.type === "memory" &&
        memoryEvent.entry.changes.some(({operation}) => operation === "set"),
    ),
    assertion(
      "the memory event precedes the terminal answer",
      memoryEvent !== undefined && memoryEvent.sequence < terminal.sequence,
    ),
    assertion(
      "the durable profile retains the preference",
      stored,
      `profile holds ${profile.memories.length} memories`,
    ),
  ];
}

function* guardrailApproval({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  yield* restate.client(Agent, agentId).setGuardrails({
    guardrails: [
      {
        id: "japan-approval",
        rule: "Require human approval before providing weather information about any location in Japan.",
      },
    ],
  });
  const configuredProfile = yield* restate.client(Agent, agentId).profile();
  const ask = yield* restate.client(Agent, agentId).ask({
    message: "What is the current weather in Tokyo, Japan?",
  });
  requireStarted(ask);
  const approvalRequestEvent = yield* waitForTurnMilestone(
    history,
    ask.turnId,
    "the guardrail approval request",
    isWaitingForGuardrail(ask.turnId, "japan-approval"),
  );
  const pending = yield* restate.client(Agent, agentId).approvals();
  const approval = pending.find(
    ({turnId, guardrailId}) =>
      turnId === ask.turnId && guardrailId === "japan-approval",
  );
  const resolved = approval
    ? yield* restate.client(Agent, agentId).resolveApproval({
        approvalId: approval.approvalId,
        decision: "approved",
        reason: "Approved by the eval",
      })
    : false;
  const terminal = yield* waitForHistory(
    history,
    "the approved turn to finish",
    isTerminalFor(ask.turnId),
  );
  const approvalEvent = history.entries.find(
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "approval" &&
      entry.turnId === ask.turnId &&
      entry.approvalId === approval?.approvalId,
  );

  const followup = yield* restate.client(Agent, agentId).ask({
    message:
      "Without retrieving new weather, tell me whether the previous human approval was approved or rejected and include its recorded reason. Do not request another approval.",
  });
  requireStarted(followup);
  const followupMilestone = yield* waitForHistory(
    history,
    "the approval-history follow-up to finish or request another approval",
    (candidate) =>
      isTerminalFor(followup.turnId)(candidate) ||
      isWaitingForApproval(followup.turnId)(candidate),
  );
  const repeatedApproval = !isTerminalFor(followup.turnId)(followupMilestone);
  if (repeatedApproval) {
    const unexpected = (yield* restate.client(Agent, agentId).approvals()).find(
      ({turnId}) => turnId === followup.turnId,
    );
    if (unexpected) {
      yield* restate.client(Agent, agentId).resolveApproval({
        approvalId: unexpected.approvalId,
        decision: "rejected",
        reason: "The prior decision is already in the transcript",
      });
    }
  }
  const followupTerminal = repeatedApproval
    ? yield* waitForHistory(
        history,
        "the approval-history follow-up to finish",
        isTerminalFor(followup.turnId),
      )
    : followupMilestone;
  const followupText =
    followupTerminal.entry.role === "assistant"
      ? followupTerminal.entry.text.toLowerCase()
      : "";

  return [
    assertion(
      "the configured guardrail is visible in the authoritative profile",
      configuredProfile.guardrails.some(({id}) => id === "japan-approval"),
    ),
    assertion(
      "the approval request is a structured history event",
      approvalRequestEvent.entry.role === "event" &&
        approvalRequestEvent.entry.type === "approval_request" &&
        approvalRequestEvent.entry.approvalId === approval?.approvalId &&
        approvalRequestEvent.entry.question.length > 0,
    ),
    assertion(
      "exactly one approval is pending",
      pending.length === 1,
      `found ${pending.length}`,
    ),
    assertion(
      "the approval belongs to the runtime guardrail",
      approval?.guardrailId === "japan-approval",
    ),
    assertion("the approval signal is accepted", resolved),
    assertion(
      "the resolution is recorded in conversation history",
      approvalEvent?.entry.role === "event" &&
        approvalEvent.entry.type === "approval" &&
        approvalEvent.entry.decision === "approved" &&
        approvalEvent.entry.reason === "Approved by the eval",
    ),
    assertion(
      "the approval event precedes the terminal answer",
      approvalEvent !== undefined && approvalEvent.sequence < terminal.sequence,
    ),
    assertion(
      "the approved turn completes",
      terminal.entry.role === "assistant" &&
        terminal.entry.status === "completed",
    ),
    assertion(
      "the response identifies Tokyo",
      terminal.entry.role === "assistant" &&
        terminal.entry.text.toLowerCase().includes("tokyo"),
    ),
    assertion(
      "a later turn does not reopen the resolved approval",
      !repeatedApproval,
    ),
    assertion(
      "a later turn can use the recorded decision",
      followupTerminal.entry.role === "assistant" &&
        followupTerminal.entry.status === "completed" &&
        followupText.includes("approved") &&
        followupText.includes("eval"),
    ),
  ];
}

function* guardrailScope({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  const introduction = yield* restate.client(Agent, agentId).ask({
    message:
      "My name is Bob and I live in Tokyo, Japan. Remember this for future turns.",
  });
  requireStarted(introduction);
  yield* waitForHistory(
    history,
    "the identity turn to finish",
    isTerminalFor(introduction.turnId),
  );

  yield* restate.client(Agent, agentId).setGuardrails({
    guardrails: [
      {
        id: "a",
        rule: "Always request a human approval to answer any question about Japan",
      },
    ],
  });

  const japan = yield* restate.client(Agent, agentId).ask({
    message: "What is the weather in Tokyo?",
  });
  requireStarted(japan);
  yield* waitForTurnMilestone(
    history,
    japan.turnId,
    "the Japan guardrail approval request",
    isWaitingForGuardrail(japan.turnId, "a"),
  );
  const japanApproval = (yield* restate
    .client(Agent, agentId)
    .approvals()).find(
    ({turnId, guardrailId}) => turnId === japan.turnId && guardrailId === "a",
  );
  const japanResolved = japanApproval
    ? yield* restate.client(Agent, agentId).resolveApproval({
        approvalId: japanApproval.approvalId,
        decision: "approved",
        reason: "Japan weather approved by the eval",
      })
    : false;
  const japanTerminal = yield* waitForHistory(
    history,
    "the approved Japan turn to finish",
    isTerminalFor(japan.turnId),
  );

  const usa = yield* restate.client(Agent, agentId).ask({
    message: "And what is the weather in the US?",
  });
  requireStarted(usa);
  const usaMilestone = yield* waitForHistory(
    history,
    "the U.S. turn to finish or request an unexpected approval",
    (candidate) =>
      isTerminalFor(usa.turnId)(candidate) ||
      isWaitingForGuardrail(usa.turnId, "a")(candidate),
  );
  const unexpectedUsaApproval = !isTerminalFor(usa.turnId)(usaMilestone);
  if (unexpectedUsaApproval) {
    const pending = (yield* restate.client(Agent, agentId).approvals()).find(
      ({turnId}) => turnId === usa.turnId,
    );
    if (pending) {
      yield* restate.client(Agent, agentId).resolveApproval({
        approvalId: pending.approvalId,
        decision: "rejected",
        reason: "The Japan-only policy does not apply to the United States",
      });
    }
  }
  const usaTerminal = unexpectedUsaApproval
    ? yield* waitForHistory(
        history,
        "the U.S. turn to finish after rejecting its unexpected approval",
        isTerminalFor(usa.turnId),
      )
    : usaMilestone;
  const usaResponse =
    usaTerminal.entry.role === "assistant"
      ? usaTerminal.entry.text.toLowerCase()
      : "";

  const newYork = yield* restate.client(Agent, agentId).ask({message: "NYC"});
  requireStarted(newYork);
  const newYorkMilestone = yield* waitForHistory(
    history,
    "the New York turn to finish or request an unexpected approval",
    (candidate) =>
      isTerminalFor(newYork.turnId)(candidate) ||
      isWaitingForGuardrail(newYork.turnId, "a")(candidate),
  );
  const unexpectedNewYorkApproval = !isTerminalFor(newYork.turnId)(
    newYorkMilestone,
  );
  if (unexpectedNewYorkApproval) {
    const pending = (yield* restate.client(Agent, agentId).approvals()).find(
      ({turnId}) => turnId === newYork.turnId,
    );
    if (pending) {
      yield* restate.client(Agent, agentId).resolveApproval({
        approvalId: pending.approvalId,
        decision: "rejected",
        reason: "The Japan-only policy does not apply to New York",
      });
    }
  }
  const newYorkTerminal = unexpectedNewYorkApproval
    ? yield* waitForHistory(
        history,
        "the New York turn to finish after rejecting its unexpected approval",
        isTerminalFor(newYork.turnId),
      )
    : newYorkMilestone;
  const newYorkResponse =
    newYorkTerminal.entry.role === "assistant"
      ? newYorkTerminal.entry.text.toLowerCase()
      : "";

  return [
    assertion("the Japan approval signal is accepted", japanResolved),
    assertion(
      "the approved Japan request completes",
      japanTerminal.entry.role === "assistant" &&
        japanTerminal.entry.status === "completed",
    ),
    assertion(
      "the Japan-only guardrail does not request approval for the U.S.",
      !unexpectedUsaApproval && !unexpectedNewYorkApproval,
      `${Number(unexpectedUsaApproval) + Number(unexpectedNewYorkApproval)} unexpected approval request(s)`,
    ),
    assertion(
      "the U.S. clarification is not blocked as a policy violation",
      usaTerminal.entry.role === "assistant" &&
        usaTerminal.entry.status === "completed" &&
        !usaResponse.includes("policy") &&
        !usaResponse.includes("guardrail") &&
        !usaResponse.includes("can’t complete") &&
        !usaResponse.includes("can't complete"),
    ),
    assertion(
      "the New York weather tool runs",
      protectedWeatherRan(history, newYork.turnId),
    ),
    assertion(
      "the out-of-scope New York request completes",
      newYorkTerminal.entry.role === "assistant" &&
        newYorkTerminal.entry.status === "completed" &&
        newYorkResponse.includes("new york"),
    ),
  ];
}

function* guardrailDenial({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  yield* restate.client(Agent, agentId).setGuardrails({
    guardrails: [
      {
        id: "deny-japan-weather",
        rule: "Never provide or retrieve weather information about any location in Japan. Deny the action without asking for human approval.",
      },
    ],
  });
  const ask = yield* restate.client(Agent, agentId).ask({
    message: "What is the current weather in Tokyo, Japan?",
  });
  requireStarted(ask);
  const observed = yield* waitForHistory(
    history,
    "the denied turn to finish or request an unexpected approval",
    (candidate) =>
      isTerminalFor(ask.turnId)(candidate) ||
      isWaitingForGuardrail(ask.turnId, "deny-japan-weather")(candidate),
  );

  let unexpectedApproval = false;
  let terminal = observed;
  if (!isTerminalFor(ask.turnId)(observed)) {
    unexpectedApproval = true;
    const pending = yield* restate.client(Agent, agentId).approvals();
    const approval = pending.find(
      ({turnId, guardrailId}) =>
        turnId === ask.turnId && guardrailId === "deny-japan-weather",
    );
    if (approval) {
      yield* restate.client(Agent, agentId).resolveApproval({
        approvalId: approval.approvalId,
        decision: "rejected",
        reason: "This policy must deny without approval",
      });
    }
    terminal = yield* waitForHistory(
      history,
      "the denied turn to finish after rejecting its unexpected approval",
      isTerminalFor(ask.turnId),
    );
  }

  const response =
    terminal.entry.role === "assistant"
      ? terminal.entry.text.toLowerCase()
      : "";
  return [
    assertion(
      "a deny policy does not request human approval",
      !unexpectedApproval,
    ),
    assertion(
      "the protected weather tool never starts",
      !protectedWeatherRan(history, ask.turnId),
    ),
    assertion(
      "the turn returns a compliant terminal explanation",
      terminal.entry.role === "assistant" &&
        terminal.entry.status === "completed",
    ),
    assertion(
      "the response does not expose the example weather result",
      !response.includes("22°c") && !response.includes("sunny"),
    ),
  ];
}

function* guardrailRejection({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  yield* restate.client(Agent, agentId).setGuardrails({
    guardrails: [
      {
        id: "japan-approval",
        rule: "Require human approval before retrieving or providing weather information about any location in Japan.",
      },
    ],
  });
  const ask = yield* restate.client(Agent, agentId).ask({
    message: "What is the current weather in Tokyo, Japan?",
  });
  requireStarted(ask);
  yield* waitForTurnMilestone(
    history,
    ask.turnId,
    "the guardrail approval request",
    isWaitingForGuardrail(ask.turnId, "japan-approval"),
  );

  const pending = yield* restate.client(Agent, agentId).approvals();
  const approval = pending.find(
    ({turnId, guardrailId}) =>
      turnId === ask.turnId && guardrailId === "japan-approval",
  );
  const rejected = approval
    ? yield* restate.client(Agent, agentId).resolveApproval({
        approvalId: approval.approvalId,
        decision: "rejected",
        reason: "Rejected by the eval",
      })
    : false;
  const terminal = yield* waitForHistory(
    history,
    "the rejected turn to finish",
    isTerminalFor(ask.turnId),
  );
  const response =
    terminal.entry.role === "assistant"
      ? terminal.entry.text.toLowerCase()
      : "";
  const approvalEvents = guardrailApprovalEvents(
    history,
    ask.turnId,
    "japan-approval",
  );

  return [
    assertion("the rejection signal is accepted", rejected),
    assertion(
      "rejection does not create an approval loop",
      approvalEvents.length === 1,
      `found ${approvalEvents.length} approval requests`,
    ),
    assertion(
      "the protected weather tool never starts",
      !protectedWeatherRan(history, ask.turnId),
    ),
    assertion(
      "the turn ends with a compliant explanation",
      terminal.entry.role === "assistant" &&
        terminal.entry.status === "completed",
    ),
    assertion(
      "the response does not expose the example weather result",
      !response.includes("22°c") && !response.includes("sunny"),
    ),
  ];
}

function* guardrailRemoval({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  const guardrailId = "temporary-japan-approval";
  yield* restate.client(Agent, agentId).setGuardrails({
    guardrails: [
      {
        id: guardrailId,
        rule: "Require human approval before retrieving or providing weather information about any location in Japan.",
      },
    ],
  });
  const guarded = yield* restate.client(Agent, agentId).ask({
    message: "What is the current weather in Tokyo, Japan?",
  });
  requireStarted(guarded);
  yield* waitForTurnMilestone(
    history,
    guarded.turnId,
    "the temporary guardrail approval request",
    isWaitingForGuardrail(guarded.turnId, guardrailId),
  );

  const pending = yield* restate.client(Agent, agentId).approvals();
  const approval = pending.find(
    ({turnId, guardrailId: pendingGuardrailId}) =>
      turnId === guarded.turnId && pendingGuardrailId === guardrailId,
  );
  const rejected = approval
    ? yield* restate.client(Agent, agentId).resolveApproval({
        approvalId: approval.approvalId,
        decision: "rejected",
        reason: "Rejected while the temporary policy is active",
      })
    : false;
  yield* waitForHistory(
    history,
    "the rejected guarded turn to finish",
    isTerminalFor(guarded.turnId),
  );

  yield* restate.client(Agent, agentId).setGuardrails({guardrails: []});
  const clearedProfile = yield* restate.client(Agent, agentId).profile();
  const unguarded = yield* restate.client(Agent, agentId).ask({
    message: "Use the weather tool to get the current weather in Tokyo, Japan.",
  });
  requireStarted(unguarded);

  const milestone = yield* waitForHistory(
    history,
    "the unguarded Tokyo tool call, terminal response, or unexpected approval",
    (candidate) =>
      isTerminalFor(unguarded.turnId)(candidate) ||
      isWaitingForApproval(unguarded.turnId)(candidate) ||
      (candidate.entry.role === "event" &&
        candidate.entry.type === "tools" &&
        candidate.entry.turnId === unguarded.turnId &&
        candidate.entry.phase === "started" &&
        candidate.entry.calls.some(({name}) => name === "getWeather")),
  );
  const repeatedApproval = isWaitingForApproval(unguarded.turnId)(milestone);
  if (repeatedApproval) {
    const unexpected = (yield* restate.client(Agent, agentId).approvals()).find(
      ({turnId}) => turnId === unguarded.turnId,
    );
    if (unexpected) {
      yield* restate.client(Agent, agentId).resolveApproval({
        approvalId: unexpected.approvalId,
        decision: "rejected",
        reason: "No guardrail is currently configured",
      });
    }
  }
  const unguardedTerminal = isTerminalFor(unguarded.turnId)(milestone)
    ? milestone
    : yield* waitForHistory(
        history,
        "the unguarded Tokyo turn to finish",
        isTerminalFor(unguarded.turnId),
      );
  const response =
    unguardedTerminal.entry.role === "assistant"
      ? unguardedTerminal.entry.text.toLowerCase()
      : "";

  return [
    assertion("the original rejection signal is accepted", rejected),
    assertion(
      "the guarded turn does not run the protected weather tool",
      !protectedWeatherRan(history, guarded.turnId),
    ),
    assertion(
      "the cleared profile contains no guardrails",
      clearedProfile.guardrails.length === 0,
      `found ${clearedProfile.guardrails.length}`,
    ),
    assertion(
      "the removed guardrail does not request approval in a later turn",
      !repeatedApproval,
    ),
    assertion(
      "the formerly protected weather tool runs after removal",
      protectedWeatherRan(history, unguarded.turnId),
    ),
    assertion(
      "the later turn completes with the requested Tokyo result",
      unguardedTerminal.entry.role === "assistant" &&
        unguardedTerminal.entry.status === "completed" &&
        response.includes("tokyo"),
    ),
  ];
}

function* guardrailSteering({
  agentId,
  history,
}: EvalContext): restate.Operation<EvalAssertion[]> {
  yield* restate.client(Agent, agentId).setGuardrails({
    guardrails: [
      {
        id: "japan-approval",
        rule: "Require human approval before retrieving or providing weather information about any location in Japan.",
      },
    ],
  });
  const ask = yield* restate.client(Agent, agentId).ask({
    message: "What is the current weather in Tokyo, Japan?",
  });
  requireStarted(ask);
  const firstRequest = yield* waitForTurnMilestone(
    history,
    ask.turnId,
    "the first guardrail approval request",
    isWaitingForGuardrail(ask.turnId, "japan-approval"),
  );
  const firstPending = yield* restate.client(Agent, agentId).approvals();
  const firstApproval = firstPending.find(
    ({turnId, guardrailId}) =>
      turnId === ask.turnId && guardrailId === "japan-approval",
  );
  const firstResolved = firstApproval
    ? yield* restate.client(Agent, agentId).resolveApproval({
        approvalId: firstApproval.approvalId,
        decision: "approved",
        reason: "Approved before steering",
      })
    : false;

  yield* waitForTurnMilestone(
    history,
    ask.turnId,
    "the approved Tokyo weather tool to start",
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "tools" &&
      entry.turnId === ask.turnId &&
      entry.phase === "started" &&
      entry.calls.some(({name}) => name === "getWeather"),
  );
  const steered = yield* restate
    .client(Agent, agentId)
    .steer("Also include the current weather in Osaka, Japan.");
  const steerEntry = yield* waitForTurnMilestone(
    history,
    ask.turnId,
    "the steering event",
    ({entry}) =>
      entry.role === "event" &&
      entry.type === "steer" &&
      entry.turnId === ask.turnId,
  );
  const secondRequest = yield* waitForTurnMilestone(
    history,
    ask.turnId,
    "guardrail reevaluation after steering",
    isWaitingForGuardrail(ask.turnId, "japan-approval", steerEntry.sequence),
  );
  const secondPending = yield* restate.client(Agent, agentId).approvals();
  const secondApproval = secondPending.find(
    ({turnId, guardrailId}) =>
      turnId === ask.turnId && guardrailId === "japan-approval",
  );
  const secondResolved = secondApproval
    ? yield* restate.client(Agent, agentId).resolveApproval({
        approvalId: secondApproval.approvalId,
        decision: "approved",
        reason: "Approved after steering",
      })
    : false;
  const terminal = yield* waitForHistory(
    history,
    "the steered guarded turn to finish",
    isTerminalFor(ask.turnId),
  );
  const response =
    terminal.entry.role === "assistant"
      ? terminal.entry.text.toLowerCase()
      : "";
  const approvalEvents = guardrailApprovalEvents(
    history,
    ask.turnId,
    "japan-approval",
  );

  return [
    assertion("the first approval is accepted", firstResolved),
    assertion("steering is accepted", steered),
    assertion(
      "steering invalidates the earlier approval",
      approvalEvents.length === 2 &&
        firstRequest.sequence < steerEntry.sequence &&
        steerEntry.sequence < secondRequest.sequence,
      `found ${approvalEvents.length} approval requests`,
    ),
    assertion("the replacement approval is accepted", secondResolved),
    assertion(
      "the updated request completes in the same turn",
      terminal.entry.role === "assistant" &&
        terminal.entry.status === "completed",
    ),
    assertion(
      "the final response includes both approved locations",
      response.includes("tokyo") && response.includes("osaka"),
    ),
  ];
}

type EvalScenario = (
  context: EvalContext,
) => restate.Operation<EvalAssertion[]>;

// The complete suite in a stable order. `all` spawns every entry concurrently
// unless the request selects a subset.
const EVAL_CASES: ReadonlyArray<{
  caseId: EvalCaseId;
  scenario: EvalScenario;
}> = [
  {caseId: "basic-turn", scenario: basicTurn},
  {caseId: "steering", scenario: steering},
  {caseId: "interruption", scenario: interruption},
  {caseId: "external-cancellation", scenario: externalCancellation},
  {caseId: "interruption-replacement", scenario: interruptionReplacement},
  {caseId: "execution-limit", scenario: executionLimit},
  {caseId: "context-reduction", scenario: contextReduction},
  {caseId: "memory", scenario: memory},
  {caseId: "scheduling", scenario: scheduling},
  {caseId: "guardrail-approval", scenario: guardrailApproval},
  {caseId: "guardrail-scope", scenario: guardrailScope},
  {caseId: "guardrail-denial", scenario: guardrailDenial},
  {caseId: "guardrail-rejection", scenario: guardrailRejection},
  {caseId: "guardrail-removal", scenario: guardrailRemoval},
  {caseId: "guardrail-steering", scenario: guardrailSteering},
];

function* evaluate(
  caseId: EvalCaseId,
  {runId, attempt, timeoutSeconds}: EvalOptions,
  scenario: EvalScenario,
): restate.Operation<EvalResult> {
  const invocationId = restate.handlerRequest().id;
  const isolation = runId ? `${runId}-${invocationId}` : invocationId;
  const agentId = `eval-${isolation}-${caseId}-${attempt}`;
  const history: HistoryReader = {
    agentId,
    nextSequence: 1,
    notificationRevision: 0,
    entries: [],
    deadline: restate.sleep(timeoutSeconds * 1_000, "eval deadline"),
  };

  let assertions: EvalAssertion[];
  try {
    assertions = yield* scenario({agentId, history});
    yield* readAvailable(history);
  } catch (error) {
    if (
      !(error instanceof EvalTimeout) &&
      !(error instanceof EvalScenarioFailure)
    ) {
      throw error;
    }
    if (error instanceof EvalTimeout) {
      yield* restate.sendClient(Agent, agentId).interrupt({
        reason: "The evaluation timed out; stop unfinished work.",
      });
    }
    yield* readAvailable(history);
    assertions = [
      assertion(
        "the case reaches its required milestones",
        false,
        errorMessage(error),
      ),
    ];
  }

  assertions.push(
    assertion(
      "history sequence numbers are contiguous",
      history.entries.every(({sequence}, index) => sequence === index + 1),
    ),
  );
  return {
    caseId,
    agentId,
    status: assertions.every(({passed}) => passed) ? "passed" : "failed",
    assertions,
    transcript: history.entries,
  };
}

export const Evals = restate.service({
  name: "Evals",
  handlers: {
    all: restate.schemas(
      {input: EvalOptionsSchema, output: EvalSuiteResultSchema},
      function* (options: EvalOptions): restate.Operation<EvalSuiteResult> {
        const selected = options.cases;
        const results = yield* restate.all(
          EVAL_CASES.filter(
            ({caseId}) => selected === undefined || selected.includes(caseId),
          ).map(({caseId, scenario}) =>
            restate.spawn(evaluate(caseId, options, scenario)),
          ),
        );
        return {
          status: results.every(({status}) => status === "passed")
            ? "passed"
            : "failed",
          results,
        };
      },
    ),
  },
});
