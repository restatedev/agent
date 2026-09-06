import assert from "node:assert/strict";
import test from "node:test";
import type {Context} from "@restatedev/restate-sdk";
import {
  allSettled,
  channel,
  execute,
  gen,
  InterruptedError,
  spawn,
} from "@restatedev/restate-sdk-gen";
import {Guest, ProgramError} from "../../src/ptc/guest.js";
import {executeProgram} from "../../src/ptc/runtime.js";

function context(): Context {
  return {
    request: () => ({attemptCompletedSignal: new AbortController().signal}),
  } as unknown as Context;
}

test("interrupting a program joins every child and is never caught by guest code", async () => {
  const stopped: string[] = [];
  const result = await execute(
    context(),
    gen(function* () {
      const ready = channel<void>();
      const never = channel<void>();
      const task = spawn(
        executeProgram(
          `async tools => {
      try { return await Promise.all([tools.wait({}), tools.wait({})]); }
      catch { return 'swallowed'; }
    }`,
          {
            names: ["wait"],
            *execute(request) {
              try {
                if (request.id === "call-1") yield* ready.send();
                yield* never.receive;
                return {ok: true, value: "unexpected"};
              } finally {
                stopped.push(request.id);
              }
            },
          },
        ),
      );
      yield* ready.receive;
      const reason = new InterruptedError("User stopped the turn");
      task.interrupt(reason);
      const [settled] = yield* allSettled([task]);
      assert.equal(settled.status, "rejected");
      if (settled.status === "rejected") assert.equal(settled.reason, reason);
      return "stopped";
    }),
  );
  assert.equal(result, "stopped");
  assert.deepEqual(stopped.sort(), ["call-0", "call-1"]);
});

test("root completion stops and joins a racing loser", async () => {
  let joined = false;
  const result = await execute(
    context(),
    gen(function* () {
      const never = channel<void>();
      return yield* executeProgram(
        `async tools => {
      const winner = await Promise.race([tools.wait({}), tools.fast({})]);
      return winner;
    }`,
        {
          names: ["wait", "fast"],
          *execute(request) {
            if (request.name === "fast") return {ok: true, value: "fast"};
            try {
              yield* never.receive;
              return {ok: true, value: "slow"};
            } finally {
              joined = true;
            }
          },
        },
      );
    }),
  );
  assert.equal(result, "fast");
  assert.equal(joined, true);
});

test("a child infrastructure failure remains retryable even after root completion", async () => {
  const failure = new Error("SDK unavailable");
  await assert.rejects(
    execute(
      context(),
      gen(function* () {
        return yield* executeProgram(
          "async tools => { tools.broken({}); return 42; }",
          {
            names: ["broken"],
            *execute() {
              throw failure;
            },
          },
        );
      }),
    ),
    (error) => error === failure,
  );
});

test("guest bridge is private, arguments are copied, and only discovered tools are exposed", () => {
  const guest = new Guest(
    `async tools => {
    const input = {n: 1}; const done = tools.lookup(input); input.n = 2;
    return {value: await done, keys: Object.keys(tools),
      globals: [typeof __deliver, typeof __snapshot, typeof __request, typeof process, typeof fetch, typeof Date],
      lexical: [typeof request, typeof pending, typeof snapshot]};
  }`,
    ["lookup"],
  );
  try {
    guest.drain();
    assert.deepEqual(guest.takeRequests(), [
      {id: "call-0", name: "lookup", args: [{n: 1}]},
    ]);
    guest.deliver("call-0", {ok: true, value: {n: 3}});
    guest.drain();
    assert.deepEqual(guest.state(), {
      status: "fulfilled",
      value: {
        value: {n: 3},
        keys: ["lookup"],
        globals: Array(6).fill("undefined"),
        lexical: Array(3).fill("undefined"),
      },
    });
  } finally {
    guest.dispose();
  }
});

test("source, output, and tool-call limits bound a generated program", async () => {
  assert.throws(() => new Guest(" ".repeat(64_001), []), ProgramError);
  await assert.rejects(
    execute(
      context(),
      gen(function* () {
        return yield* executeProgram("async tools => 'x'.repeat(64001)", {
          names: [],
          *execute() {
            throw new Error("unused");
          },
        });
      }),
    ),
    /result exceeds/,
  );
  const guest = new Guest(
    "async tools => { await tools.a({}); return tools.a({}); }",
    ["a"],
    {maxToolCalls: 1},
  );
  try {
    guest.drain();
    assert.equal(guest.takeRequests().length, 1);
    guest.deliver("call-0", {ok: true, value: null});
    guest.drain();
    assert.equal(guest.state().status, "rejected");
    assert.equal(guest.takeRequests().length, 0);
  } finally {
    guest.dispose();
  }
});
