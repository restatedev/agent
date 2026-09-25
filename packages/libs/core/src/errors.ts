// Error classification shared by every durable handler.

import {RunFailedError, ToolError} from "@restate-agents/core";
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

/**
 * Runs a call into the Agent controller from a tool. Its rejections with
 * `codes` are feedback the model can act on. Any other terminal rejection,
 * such as a stale turn (409), fails the turn: it would fail every retry the
 * model could make. Cancellation and transient errors propagate as they are.
 */
export function* agentRequest<T>(
  operation: () => restate.Operation<T>,
  codes: readonly number[] = [],
  prefix = "",
): restate.Operation<T> {
  try {
    return yield* operation();
  } catch (error) {
    if (isRejection(error, codes)) throw new ToolError(prefix + error.message);
    if (error instanceof TerminalError && !(error instanceof CancelledError))
      throw new RunFailedError(error.message);
    throw error;
  }
}
