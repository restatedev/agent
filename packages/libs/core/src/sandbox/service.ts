// One agent-scoped Sandbox virtual object owns the lifecycle of its external
// sandbox. Turns borrow it lazily through tools and release it when they end.

import {rpc, TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {executionRetention} from "../retention.js";
import {
  type SandboxRef,
  SandboxRefSchema,
  sandboxProvider,
} from "./provider.js";

const BorrowSchema = z.object({turnId: z.string().min(1)});
const ReleaseSchema = BorrowSchema;

type SandboxState =
  | {status: "borrowed"; ref: SandboxRef; turnId: string}
  | {status: "idle"; ref: SandboxRef; timerId: string}
  | {status: "suspended"; ref: SandboxRef};

const STATE = "sandbox";
const IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

/**
 * Agent-scoped durable owner of sandbox provisioning, leases, idle suspension,
 * resumption, and destruction.
 */
export const Sandbox = restate.object({
  name: "Sandbox",
  options: {
    handlers: {
      borrow: executionRetention,
      release: executionRetention,
      suspend: executionRetention,
      destroy: executionRetention,
      retire: executionRetention,
    },
  },
  handlers: {
    retire: restate.schemas(
      {input: z.void(), output: z.void()},
      function* (): restate.Operation<void> {
        restate.state().set("deleted", true);
        const current = yield* readSandbox();
        // A borrowed sandbox is destroyed by release after the turn stops.
        if (!current || current.status === "borrowed") return;
        if (current.status === "idle")
          restate.invocation(current.timerId).cancel();
        yield* destroyRef(current.ref);
      },
    ),
    borrow: restate.schemas(
      {input: BorrowSchema, output: SandboxRefSchema},
      function* ({turnId}): restate.Operation<SandboxRef> {
        const agentId = sandboxKey();
        if (yield* restate.state().get<boolean>("deleted"))
          throw new TerminalError("Agent has been deleted", {errorCode: 410});
        const current = yield* readSandbox();
        if (current?.status === "borrowed") {
          if (current.turnId !== turnId) {
            throw new TerminalError(
              `sandbox is already borrowed by turn ${current.turnId}`,
            );
          }
          return current.ref;
        }
        if (current?.status === "idle") {
          restate.invocation(current.timerId).cancel();
        }

        let ref: SandboxRef;
        if (!current) {
          ref = yield* restate.run(
            ({signal}) => sandboxProvider.provision({agentId, signal}),
            {name: "provisionSandbox"},
          );
        } else {
          ref = current.ref;
          if (current.status === "suspended") {
            ref = yield* restate.run(
              ({signal}) => sandboxProvider.resume(ref, {signal}),
              {name: "resumeSandbox"},
            );
          }
        }

        restate.state().set(STATE, {
          ref,
          status: "borrowed",
          turnId,
        } satisfies SandboxState);
        return ref;
      },
    ),

    release: restate.schemas(
      {input: ReleaseSchema, output: z.void()},
      function* ({turnId}): restate.Operation<void> {
        const current = yield* readSandbox();
        if (current?.status !== "borrowed" || current.turnId !== turnId) {
          return;
        }
        if (yield* restate.state().get<boolean>("deleted")) {
          yield* destroyRef(current.ref);
          return;
        }

        const timer = yield* restate
          .sendClient(Sandbox, sandboxKey())
          .suspend(rpc.sendOpts({delay: IDLE_TIMEOUT_MS}));
        restate.state().set(STATE, {
          ref: current.ref,
          status: "idle",
          timerId: timer.id,
        } satisfies SandboxState);
      },
    ),

    suspend: restate.schemas(
      {input: z.void(), output: z.void()},
      function* (): restate.Operation<void> {
        const current = yield* readSandbox();
        if (
          current?.status !== "idle" ||
          current.timerId !== restate.handlerRequest().id
        ) {
          return;
        }

        const ref = yield* restate.run(
          ({signal}) => sandboxProvider.suspend(current.ref, {signal}),
          {name: "suspendSandbox"},
        );
        restate.state().set(STATE, {
          ref,
          status: "suspended",
        } satisfies SandboxState);
      },
    ),

    destroy: restate.schemas(
      {input: z.void(), output: z.void()},
      function* (): restate.Operation<void> {
        const current = yield* readSandbox();
        if (!current) {
          return;
        }
        if (current.status === "borrowed") {
          throw new TerminalError(
            `cannot destroy a sandbox borrowed by turn ${current.turnId}`,
          );
        }
        if (current.status === "idle") {
          restate.invocation(current.timerId).cancel();
        }
        yield* restate.run(
          ({signal}) => sandboxProvider.destroy(current.ref, {signal}),
          {name: "destroySandbox"},
        );
        restate.state().clear(STATE);
      },
    ),
  },
});

function* destroyRef(ref: SandboxRef): restate.Operation<void> {
  yield* restate.run(({signal}) => sandboxProvider.destroy(ref, {signal}), {
    name: "destroyRetiredSandbox",
  });
  restate.state().clear(STATE);
}

function sandboxKey(): string {
  const key = restate.handlerRequest().key;
  if (!key) {
    throw new TerminalError("Sandbox handlers require an agent key");
  }
  return key;
}

function* readSandbox(): restate.Operation<SandboxState | undefined> {
  return (yield* restate.state().get<SandboxState>(STATE)) ?? undefined;
}
