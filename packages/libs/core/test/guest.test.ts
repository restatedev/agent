import assert from "node:assert/strict";
import test from "node:test";

import {type Context} from "@restatedev/restate-sdk";

import {
  Guest,
  ProgramError,
  type Outcome,
  type Request,
} from "../src/ptc/guest.js";
import {executeWithTools as executeProgram} from "./adapter.js";
const demoProgram = `async tools => {
  const completionOrder = [];
  const branches = ["a", "b"].map(async key => {
    const item = await tools.lookup(key);
    const score = await tools.score(item);
    completionOrder.push(key);
    return { key, score };
  });
  const winner = await Promise.race(branches);
  const results = await Promise.all(branches);
  await tools.checkpoint(winner);
  return { winner, results, completionOrder };
}`;

function runTrace(
  source: string,
  choose: (requests: Request[]) => Request,
  recorded?: {id: string; outcome: Outcome}[],
) {
  const guest = new Guest(source, ["lookup", "score", "checkpoint"]);
  const pending: Request[] = [];
  const calls: Request[] = [];
  const events: {id: string; outcome: Outcome}[] = [];
  try {
    for (let step = 0; step < 100; step++) {
      guest.drain();
      const requests = guest.takeRequests();
      calls.push(...requests);
      pending.push(...requests);
      const state = guest.state();
      if (state.status !== "pending") return {calls, events, state};
      const event = recorded?.[step];
      const request = event
        ? pending.find((r) => r.id === event.id)!
        : choose(pending);
      assert.ok(
        request,
        "Every delivered completion must have a matching call",
      );
      const outcome: Outcome = event?.outcome ?? {
        ok: true,
        value:
          request.name === "lookup"
            ? {key: request.args[0]!, amount: 10}
            : request.name === "score"
              ? 20
              : null,
      };
      pending.splice(pending.indexOf(request), 1);
      events.push({id: request.id, outcome});
      guest.deliver(request.id, outcome);
    }
    throw new Error("Too many turns");
  } finally {
    guest.dispose();
  }
}

test("multistep race reproduces calls, arguments, winner, and output from a completion trace", () => {
  // Finish branch b first, even though a was issued first.
  const live = runTrace(demoProgram, (requests) => requests.at(-1)!);
  const replay = runTrace(
    demoProgram,
    () => {
      throw new Error("No live I/O on replay");
    },
    live.events,
  );
  assert.deepEqual(replay, live);
  assert.equal(live.state.status, "fulfilled");
  if (live.state.status === "fulfilled") {
    assert.deepEqual(live.state.value, {
      winner: {key: "b", score: 20},
      results: [
        {key: "a", score: 20},
        {key: "b", score: 20},
      ],
      completionOrder: ["b", "a"],
    });
  }
  // The same values alone do NOT preserve the winner if event order changes.
  const otherOrder = runTrace(demoProgram, (requests) => requests[0]!);
  assert.notDeepEqual(otherOrder.state, live.state);
});

test("native Promise.any/allSettled handle a guest rejection and a fulfillment", () => {
  const source = `async tools => {
    const a = tools.lookup("a");
    const b = tools.lookup("b");
    const winner = await Promise.any([a, b]);
    const settled = await Promise.allSettled([a, b]);
    return { winner, statuses: settled.map(x => x.status) };
  }`;
  const events: {id: string; outcome: Outcome}[] = [
    {
      id: "call-0",
      outcome: {ok: false, error: {name: "Error", message: "missing"}},
    },
    {id: "call-1", outcome: {ok: true, value: "b"}},
  ];
  const result = runTrace(
    source,
    () => {
      throw new Error("Unexpected I/O");
    },
    events,
  );
  assert.deepEqual(result.state, {
    status: "fulfilled",
    value: {winner: "b", statuses: ["rejected", "fulfilled"]},
  });
});

// Pure guest failures happen before any durable operation. This minimal context
// lets the real gen scheduler run without pretending to implement a journal.
function contextWithRun(run?: (...args: unknown[]) => unknown): Context {
  return {
    request: () => ({attemptCompletedSignal: new AbortController().signal}),
    run:
      run ??
      (() => {
        throw new Error("Unexpected tool call");
      }),
  } as unknown as Context;
}

test("deterministic program failures terminate instead of retrying the same source", async (t) => {
  const cases: [string, string, RegExp][] = [
    [
      "syntax",
      "async tools => { this is invalid JS }",
      /Guest evaluation failed/,
    ],
    [
      "ordinary throw",
      'async tools => { throw new Error("bad program"); }',
      /bad program/,
    ],
    ["BigInt output", "async tools => 1n", /BigInt|bigint/],
    [
      "cyclic output",
      "async tools => { const x = {}; x.self = x; return x; }",
      /circular/i,
    ],
    ["undefined output", "async tools => undefined", /must return JSON/],
    ["function output", "async tools => (() => 1)", /must return JSON/],
    [
      "throwing toJSON",
      'async tools => ({ toJSON() { throw new Error("bad JSON"); } })',
      /bad JSON/,
    ],
    [
      "unprintable error",
      `async tools => { throw {
      get name() { throw null; }, get message() { throw null; }
    }; }`,
      /Unprintable guest error/,
    ],
  ];
  for (const [name, source, message] of cases) {
    await t.test(name, async () => {
      // Reconstruct twice, just as a repeated invocation attempt would do.
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(
          executeProgram(contextWithRun(), source, {}),
          (error) =>
            error instanceof ProgramError && message.test(error.message),
        );
      }
    });
  }
});

test("instruction and microtask budgets are terminal even with guest catch handlers", async () => {
  await assert.rejects(
    executeProgram(
      contextWithRun(),
      `async tools => {
    try { while (true) {} } catch { return "caught"; }
  }`,
      {},
      {maxInterruptChecks: 10},
    ),
    (error) =>
      error instanceof ProgramError &&
      /execution budget exceeded/.test(error.message),
  );
  await assert.rejects(
    executeProgram(
      contextWithRun(),
      `async tools => {
    await new Promise(() => {
      const spin = () => Promise.resolve().then(spin);
      spin();
    });
    return null;
  }`,
      {},
      {maxJobsPerDrain: 20},
    ),
    (error) =>
      error instanceof ProgramError &&
      /microtask budget exceeded/.test(error.message),
  );
});

test("SDK failures are propagated unchanged and never delivered to guest catch handlers", async () => {
  const failure = new Error("simulated SDK failure");
  await assert.rejects(
    executeProgram(
      contextWithRun(() => {
        throw failure;
      }),
      'async tools => { try { return await tools.lookup("a"); } catch { return "caught"; } }',
      {lookup: async () => "a"},
    ),
    (error) => error === failure,
  );
});

test("output serialization emits requests during the drain and snapshots only once", () => {
  const guest = new Guest(
    `async tools => ({
    toJSON() { tools.lookup("serialized"); return { answer: 42 }; }
  })`,
    ["lookup"],
  );
  try {
    guest.drain();
    assert.deepEqual(guest.takeRequests(), [
      {id: "call-0", name: "lookup", args: ["serialized"]},
    ]);
    assert.deepEqual(guest.state(), {status: "fulfilled", value: {answer: 42}});
    assert.deepEqual(guest.state(), {status: "fulfilled", value: {answer: 42}});
    assert.deepEqual(guest.takeRequests(), []);
  } finally {
    guest.dispose();
  }
});
