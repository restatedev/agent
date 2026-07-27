// Bounded semantic progress for one Agent virtual object. Progress is useful
// for status UIs but is not part of the canonical conversation transcript.

import {type Operation, sharedState, state} from "@restatedev/restate-sdk-gen";
import type {ProgressEvent, ProgressReport} from "./types.js";

type ProgressState = {
  nextSequence: number;
  events: ProgressEvent[];
};

const PROGRESS_STATE = "progress";
const MAX_PROGRESS_EVENTS = 32;

function* readState(): Operation<ProgressState> {
  return (
    (yield* sharedState().get<ProgressState>(PROGRESS_STATE)) ?? {
      nextSequence: 1,
      events: [],
    }
  );
}

/**
 * Handler-scoped access to the current Agent object's progress log.
 *
 * Events have a stable sequence across turns, while retention is intentionally
 * bounded because progress is status data rather than conversation history.
 */
export const progress = {
  *append(report: ProgressReport): Operation<void> {
    const current = yield* readState();
    const event = {...report, sequence: current.nextSequence};
    state().set(PROGRESS_STATE, {
      nextSequence: current.nextSequence + 1,
      events: [...current.events, event].slice(-MAX_PROGRESS_EVENTS),
    } satisfies ProgressState);
  },

  *read(afterSequence: number): Operation<ProgressEvent[]> {
    const current = yield* readState();
    return current.events.filter(({sequence}) => sequence > afterSequence);
  },
};
