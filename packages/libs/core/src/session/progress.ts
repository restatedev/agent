// Projects one run's progress into the public transcript. Raw tool
// arguments and results stay in the journal.

import type {
  JsonValue,
  ProgressEvent,
  SteeringUpdate,
  ToolResult,
} from "@restate-agents/core";
import type {ConversationEntry} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";

import {
  AGENT_SESSION_SIGNALS,
  type AgentSessionSteering,
} from "../internal-types.js";
import {steeringMessage} from "./context.js";
import {resetPolicy} from "./guardrails.js";
import type {TurnContext} from "./turn-context.js";

type ToolsEvent = Extract<ConversationEntry, {type: "tools"}>;
type ToolStatus = NonNullable<ToolsEvent["calls"][number]["status"]>;

function toolStatus(result: ToolResult): ToolStatus {
  switch (result.status) {
    case "success":
      return "succeeded";
    case "pending":
      return "pending";
    case "cancelled":
      return "cancelled";
    case "error":
    case "denied":
      return "failed";
  }
}

// The Agent's steering signal is plain JSON, but its entry types have
// optional fields that the SDK's JsonValue cannot express.
const toData = (signal: AgentSessionSteering) => signal as unknown as JsonValue;
const fromData = (data: JsonValue | undefined) =>
  data as unknown as AgentSessionSteering;

/** The steering source and progress handler for one run. */
export function turnProgress(context: TurnContext) {
  const {transcript, turnId} = context;
  let consumed = 0;
  let step = 1;
  const toolsEvent = (
    phase: ToolsEvent["phase"],
    call: ToolsEvent["calls"][number],
  ) =>
    transcript.append({
      role: "event",
      type: "tools",
      turnId,
      step,
      phase,
      calls: [call],
    });

  return {
    /** Accepted steering signals, reported to the Agent for reconciliation. */
    get consumedSteering() {
      return consumed;
    },

    /** Waits for the next durable steering signal; it rides along as data. */
    steering(): restate.Future<SteeringUpdate> {
      return restate.spawn(
        restate.gen(function* () {
          const signal = yield* restate.signal<AgentSessionSteering>(
            AGENT_SESSION_SIGNALS.steering,
          );
          return {
            message: steeringMessage(signal).content,
            data: toData(signal),
          };
        }),
      );
    },

    *record(event: ProgressEvent): restate.Operation<void> {
      switch (event.type) {
        case "step":
          step = event.step;
          return yield* transcript.append({
            role: "event",
            type: "progress",
            turnId,
            phase: "thinking",
            message: "Thinking...",
          });
        case "tool-start":
          return yield* toolsEvent("started", {
            id: event.callId,
            name: event.name,
            ...(event.info ? {summary: event.info.name} : {}),
          });
        case "tool-end": {
          // Only a tool's `describe` renames it; the default names the tool.
          const summary =
            event.info.name === event.name ? undefined : event.info.name;
          return yield* toolsEvent("finished", {
            id: event.callId,
            name: event.name,
            ...(summary ? {summary} : {}),
            status: toolStatus(event.result),
          });
        }
        case "steering": {
          // Counted as each batch lands, so a failure part-way through does
          // not make the Agent re-queue a batch the transcript already holds.
          const signal = fromData(event.data);
          consumed += 1;
          resetPolicy(context.policy);
          return yield* transcript.append(
            ...signal.queued,
            {role: "user", text: signal.message, delivery: "steer"},
            {
              role: "event",
              type: "steer",
              turnId,
              queuedMessages: signal.queued.filter(({role}) => role === "user")
                .length,
            },
          );
        }
        case "tool-info":
        case "tool-progress":
        case "handoff":
          return;
      }
    },
  };
}
