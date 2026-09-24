// Error classification shared by every durable handler.

import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

/**
 * Invocation cancellation or an interrupted task. These always propagate:
 * reporting one as an ordinary failure would keep cancelled work running.
 */
export function isCancellation(error: unknown): boolean {
  return (
    error instanceof restate.InterruptedError || error instanceof CancelledError
  );
}

/** A terminal rejection with one of `codes`, which the caller can report. */
export function isRejection(
  error: unknown,
  codes: readonly number[],
): error is TerminalError {
  return (
    error instanceof TerminalError &&
    !(error instanceof CancelledError) &&
    codes.includes(error.code)
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
