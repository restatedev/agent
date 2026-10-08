import assert from "node:assert/strict";
import {test} from "node:test";

import {serde, TerminalError} from "@restatedev/restate-sdk";
import * as durable from "@restatedev/restate-sdk-gen";

import {createCallbackTool} from "../src/tools/callback.ts";
import {runHandler} from "./harness.mjs";

const CALLBACK_ID = "sign_1test";

// The test harness cannot deliver an awakeable completion or fire a timer, so
// both are journaled runs. `post` returns the body the caller "posted", or
// throws to stand in for a POST to the reject URL. `timer` decides when the
// timeout fires.
function contextWithCallback(ctx, post, timer) {
  return new Proxy(ctx, {
    get(target, key) {
      if (key === "awakeable") {
        return () => ({
          id: CALLBACK_ID,
          promise: ctx.run("callback", post, {serde: serde.binary}),
        });
      }
      if (key === "sleep") {
        return (_duration, name) => ctx.run(name, timer);
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function toolContext() {
  return {
    agentId: "test",
    turnId: "turn",
    toolCallId: "call-1",
    webSearchEnabled: false,
    permissions: {builtin: {mode: "all"}, dynamic: {mode: "all"}, mcp: []},
    sandbox: {
      *client() {
        throw new Error("sandbox not used");
      },
    },
    callbacks: new Map(),
  };
}

// Runs the tool's two phases as the turn does: `run` first, then `complete`
// with the same input and context.
function runCallback({post, timer = never, replay = []}) {
  return runHandler(
    (ctx) =>
      durable.execute(
        contextWithCallback(ctx, post, timer),
        durable.gen(function* () {
          const context = toolContext();
          const started = yield* createCallbackTool.run(input, context);
          const completed = yield* createCallbackTool.complete(input, context);
          return {started, completed, waiting: context.callbacks.size};
        }),
      ),
    {replay},
  );
}

const input = {purpose: "remote build", timeoutSeconds: 3600};

function never() {
  return new Promise(() => {});
}

async function fireNow() {
  return null;
}

test("createCallback returns the awakeable's URLs and completes with the posted body", async () => {
  const post = async () => new TextEncoder().encode('{"status":"done"}');
  const live = await runCallback({post});
  const {started, completed, waiting} = live.output;

  assert.equal(started.status, "pending");
  assert.deepEqual(started.result, {
    operationId: "call-1",
    status: "waiting",
    purpose: "remote build",
    callbackId: CALLBACK_ID,
    resolveUrl: `http://localhost:8080/restate/awakeables/${CALLBACK_ID}/resolve`,
    rejectUrl: `http://localhost:8080/restate/awakeables/${CALLBACK_ID}/reject`,
    timeoutSeconds: 3600,
  });
  assert.deepEqual(completed, {
    status: "succeeded",
    result: '{"status":"done"}',
  });
  assert.equal(waiting, 0);

  const replay = await runCallback({post, replay: live.journal});
  assert.deepEqual(replay.output, live.output);
});

test("createCallback reports a rejected callback as a failure", async () => {
  const post = async () => {
    throw new TerminalError("tests failed");
  };
  const {output} = await runCallback({post});

  assert.equal(output.completed.status, "failed");
  assert.match(
    output.completed.error,
    /remote build reported a failure: tests failed/,
  );
});

test("createCallback fails once the timeout passes", async () => {
  const {output} = await runCallback({post: never, timer: fireNow});

  assert.equal(output.completed.status, "failed");
  assert.match(
    output.completed.error,
    /No callback for remote build arrived within 3600 seconds/,
  );
  assert.equal(output.waiting, 0);
});
