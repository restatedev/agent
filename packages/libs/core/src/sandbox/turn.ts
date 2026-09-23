// The turn owns its agent's sandbox. AgentSession.doTurn is exclusive per
// agent, so at most one turn uses the sandbox at a time and no lease is
// needed. The first sandbox tool of a turn provisions or resumes it; the turn
// suspends it when it ends. Suspension keeps the persistent files (a Modal
// Volume, a local directory) and releases only compute.

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
 * Acquisition runs as its own task, so parallel tools share one provisioning
 * and interrupting the tool that started it does not abandon it half way.
 */
export function openTurnSandbox(agentId: string): TurnSandbox {
  let acquired: restate.Task<SandboxRef> | undefined;
  let released = false;
  return {
    *client() {
      acquired ??= restate.spawn(acquire(agentId));
      return sandboxProvider.connect(yield* acquired);
    },

    *release() {
      if (!acquired || released) return;
      released = true;
      const [settled] = yield* restate.allSettled([acquired]);
      // A failed acquisition left the stored reference unchanged.
      if (settled.status !== "fulfilled") return;
      const ref = yield* restate.run(
        ({signal}) => sandboxProvider.suspend(settled.value, {signal}),
        {name: "suspendSandbox"},
      );
      restate.state().set(STATE, ref);
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
