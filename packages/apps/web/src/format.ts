// Small formatting and feedback helpers shared by the conversation views.

export function shortTurn(turnId: string) {
  return turnId.length > 14 ? `${turnId.slice(0, 14)}…` : turnId;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type Notify = (message: string, error?: boolean) => void;

/**
 * Runs one UI action and reports it as a toast: the returned message (or
 * `[message, isError]`) on success, the error message on failure. Never throws.
 */
export async function runAction(
  notify: Notify,
  action: () => Promise<string | [string, boolean] | void>,
): Promise<void> {
  try {
    const result = await action();
    if (typeof result === "string") {
      notify(result);
    } else if (result) {
      notify(...result);
    }
  } catch (error) {
    notify(errorMessage(error), true);
  }
}
