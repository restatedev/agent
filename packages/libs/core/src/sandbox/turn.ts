// The turn owns its agent's sandbox. AgentSession.doTurn is exclusive per
// agent, so at most one turn uses the sandbox at a time and no lease is
// needed. The first sandbox tool of a turn provisions or resumes it; the turn
// suspends it when it ends. Suspension keeps the persistent files (a Modal
// Volume, a local directory) and releases only compute.

import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

import {
  type SandboxClient,
  type SandboxRef,
  sandboxProvider,
} from "./provider.js";

const STATE = "sandbox";

/** One turn's lazily acquired sandbox. */
export type TurnSandbox = {
  /** Provisions or resumes the sandbox on first use and connects to it. */
  client(): restate.Operation<SandboxClient>;
  /** Suspends the sandbox if this turn acquired it. Safe to repeat. */
  release(): restate.Operation<void>;
};

/**
 * Creates the turn's sandbox handle. Must be used from AgentSession.doTurn.
 *
 * Acquisition runs inline in the first tool that needs the sandbox; parallel
 * tools wait for it rather than starting their own. It is deliberately NOT a
 * task spawned by that first tool: sdk-gen cascades `interrupt` down the
 * spawn subtree, so a spawned acquisition would die with its tool (a PTC
 * `Promise.race` loser, a cancelled handed-off program) and its rejection
 * would then be shared by every other sandbox tool of the turn. Instead, an
 * interrupted owner simply gives up, and the next waiter becomes the owner
 * and acquires again. A plain failure is not cached either: the waiters and
 * later tools each try again and report their own failure.
 *
 * Replay is deterministic because which fiber owns an attempt follows from
 * fiber scheduling, which the journal drives; each attempt is a state read
 * plus one named run, in the same order as the original execution.
 */
export function openTurnSandbox(agentId: string): TurnSandbox {
  let ref: SandboxRef | undefined;
  // Settled (never rejected) when the current attempt ends, however it ends.
  let attempt: restate.Channel<void> | undefined;
  let released = false;
  return {
    *client() {
      while (true) {
        // A tool still running after the turn released the sandbox (an
        // abandoned fiber) must not provision compute nobody will suspend.
        if (released)
          throw new TerminalError("the turn's sandbox was already released");
        if (ref) return sandboxProvider.connect(ref);
        if (attempt) {
          yield* attempt.receive;
          continue;
        }
        const done = restate.channel<void>();
        attempt = done;
        try {
          ref = yield* acquire(agentId);
        } finally {
          attempt = undefined;
          yield* done.send();
        }
      }
    },

    *release() {
      if (released) return;
      released = true;
      // An attempt still in flight (its tool was cancelled with the turn)
      // ends promptly; wait so a sandbox it did acquire is suspended.
      while (attempt) yield* attempt.receive;
      if (!ref) return;
      const acquired = ref;
      const suspended = yield* restate.run(
        ({signal}) => sandboxProvider.suspend(acquired, {signal}),
        {name: "suspendSandbox"},
      );
      restate.state().set(STATE, suspended);
    },
  };
}

/**
 * Destroys the agent's sandbox and its files. Runs in AgentSession.retire,
 * which queues behind an active turn, so the sandbox is never in use here.
 */
export function* destroySandbox(): restate.Operation<void> {
  const ref = yield* restate.state().get<SandboxRef>(STATE);
  if (!ref) return;
  yield* restate.run(({signal}) => sandboxProvider.destroy(ref, {signal}), {
    name: "destroySandbox",
  });
  restate.state().clear(STATE);
}

function* acquire(agentId: string): restate.Operation<SandboxRef> {
  const stored = yield* restate.state().get<SandboxRef>(STATE);
  const ref = stored
    ? yield* restate.run(
        ({signal}) => sandboxProvider.resume(stored, {signal}),
        {name: "resumeSandbox"},
      )
    : yield* restate.run(
        ({signal}) => sandboxProvider.provision({agentId, signal}),
        {name: "provisionSandbox"},
      );
  restate.state().set(STATE, ref);
  return ref;
}
