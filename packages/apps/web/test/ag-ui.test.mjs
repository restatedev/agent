// Runs the AG-UI adapter under the real AG-UI client, which verifies every
// event sequence it receives. The agent is a fake: an in-memory history
// that tests append to, the way a turn would.
import assert from "node:assert/strict";
import {test} from "node:test";

import {HttpAgent} from "@ag-ui/client";

import {parseRunInput, runResponse} from "../src/server/ag-ui.ts";

/** An in-memory agent. `turn` scripts what its handlers do. */
function fakeAgent() {
  const log = [];
  const pending = new Map();
  const calls = [];
  let wake = () => {};

  const agent = {
    calls,
    turn: {},

    append(...entries) {
      for (const entry of entries) {
        log.push({sequence: log.length + 1, entry});
      }
      wake();
    },

    requestApproval(approvalId, turnId, question) {
      pending.set(approvalId, {approvalId, turnId, question});
      agent.append({
        role: "event",
        type: "approval_request",
        approvalId,
        turnId,
        question,
      });
    },

    async history(fromSequence = 1, limit = 100) {
      const entries = log.slice(fromSequence - 1, fromSequence - 1 + limit);
      const last = entries.at(-1);
      return {
        entries,
        nextSequence: last ? last.sequence + 1 : fromSequence,
      };
    },

    async *follow({fromSequence = 1, signal} = {}) {
      let cursor = fromSequence;
      while (!signal?.aborted) {
        if (cursor <= log.length) {
          yield log[cursor - 1];
          cursor += 1;
          continue;
        }
        await new Promise((resolve) => {
          wake = resolve;
          signal?.addEventListener("abort", resolve, {once: true});
        });
      }
    },

    async ask(message) {
      calls.push(["ask", message]);
      return agent.turn.ask(message);
    },

    async steer(message) {
      calls.push(["steer", message]);
      return agent.turn.steer(message);
    },

    async interrupt(reason) {
      calls.push(["interrupt", reason]);
      return agent.turn.interrupt(reason);
    },

    async approvals() {
      return [...pending.values()];
    },

    async resolveApproval(resolution) {
      calls.push(["resolveApproval", resolution]);
      const approval = pending.get(resolution.approvalId);
      if (!approval) {
        return false;
      }
      pending.delete(resolution.approvalId);
      agent.turn.resolved?.(approval, resolution);
      return true;
    },
  };
  return agent;
}

/** An AG-UI client whose HTTP requests go straight to the adapter. */
function agUiClient(agent, threadId = "demo") {
  const client = new HttpAgent({
    url: "http://ui.test/api/ag-ui",
    threadId,
    fetch: async (_url, init) => {
      const input = parseRunInput(JSON.parse(init.body));
      return runResponse(agent, input, init.signal);
    },
  });
  // HttpAgent has no reconnect transport of its own; a connect is a run
  // with nothing new to deliver.
  client.connect = (input) => client.run(input);
  return client;
}

function userMessage(text) {
  return {id: crypto.randomUUID(), role: "user", content: text};
}

/** Records every event the client applies. */
function recorder() {
  const events = [];
  return {
    events,
    types: () => events.map((event) => event.type),
    subscriber: {
      onEvent({event}) {
        events.push(event);
      },
    },
  };
}

function answer(turnId, text, status = "completed") {
  return {role: "assistant", text, turnId, status};
}

function toolsEvent(turnId, phase, calls) {
  return {role: "event", type: "tools", turnId, step: 1, phase, calls};
}

/** Runs `work` after the current request has had time to start following. */
function later(work) {
  setTimeout(work, 5);
}

test("a message starts a turn and the run ends with its answer", async () => {
  const agent = fakeAgent();
  agent.turn.ask = (message) => {
    later(() => {
      agent.append(
        {role: "user", text: message, delivery: "turn"},
        toolsEvent("t1", "started", [
          {id: "call-1", name: "getWeather", summary: "Weather in Berlin"},
        ]),
        toolsEvent("t1", "finished", [
          {id: "call-1", name: "getWeather", status: "succeeded"},
        ]),
        answer("t1", "It is sunny in Berlin."),
      );
    });
    return {decision: "start", turnId: "t1", stats: {pendingMessages: 0}};
  };
  const client = agUiClient(agent);
  client.addMessage(userMessage("Weather in Berlin?"));

  const {result, newMessages} = await client.runAgent();

  assert.deepEqual(agent.calls, [["ask", "Weather in Berlin?"]]);
  assert.deepEqual(result, {turnId: "t1", status: "completed"});
  const roles = client.messages.map((message) => message.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "assistant"]);
  const toolCall = client.messages[1].toolCalls[0];
  assert.equal(toolCall.function.name, "getWeather");
  assert.equal(client.messages[2].content, "succeeded");
  assert.equal(newMessages.at(-1).content, "It is sunny in Berlin.");
});

test("a queued message runs in the turn after the active one", async () => {
  const agent = fakeAgent();
  agent.turn.ask = (message) => {
    later(() => {
      agent.append(
        answer("t1", "Earlier answer."),
        {role: "user", text: message, delivery: "queued"},
        {role: "event", type: "dispatch", queuedMessages: 1},
        answer("t2", "Answer to the queued message."),
      );
    });
    return {
      decision: "queue",
      turnId: null,
      activeTurnId: "t1",
      stats: {pendingMessages: 1},
    };
  };
  const client = agUiClient(agent);
  client.addMessage(userMessage("And then?"));

  const {result} = await client.runAgent();

  assert.deepEqual(result, {turnId: "t2", status: "completed"});
  const texts = client.messages.map((message) => message.content);
  assert.deepEqual(texts, [
    "And then?",
    "Earlier answer.",
    "Answer to the queued message.",
  ]);
});

test("an approval ends the run with an interrupt, and resume continues the turn", async () => {
  const agent = fakeAgent();
  agent.turn.ask = () => {
    later(() => {
      agent.requestApproval("approval-1", "t1", "Deploy to production?");
    });
    return {decision: "start", turnId: "t1", stats: {pendingMessages: 0}};
  };
  agent.turn.resolved = (approval, resolution) => {
    later(() => {
      agent.append(
        {
          role: "event",
          type: "approval",
          approvalId: approval.approvalId,
          turnId: approval.turnId,
          question: approval.question,
          decision: resolution.decision,
        },
        answer("t1", "Deployed."),
      );
    });
  };
  const client = agUiClient(agent);
  client.addMessage(userMessage("Deploy it"));

  await client.runAgent();

  assert.equal(client.pendingInterrupts.length, 1);
  const [interrupt] = client.pendingInterrupts;
  assert.equal(interrupt.id, "approval-1");
  assert.equal(interrupt.message, "Deploy to production?");

  const {result} = await client.runAgent({
    resume: [
      {
        interruptId: "approval-1",
        status: "resolved",
        payload: {decision: "approved"},
      },
    ],
  });

  assert.deepEqual(agent.calls.at(-1), [
    "resolveApproval",
    {approvalId: "approval-1", decision: "approved"},
  ]);
  assert.deepEqual(result, {turnId: "t1", status: "completed"});
  assert.equal(client.pendingInterrupts.length, 0);
  assert.equal(client.messages.at(-1).content, "Deployed.");
});

test("an answer to an interrupt that is no longer pending fails the run", async () => {
  const agent = fakeAgent();
  const client = agUiClient(agent);
  const run = recorder();

  await client.runAgent(
    {
      resume: [
        {
          interruptId: "approval-9",
          status: "resolved",
          payload: {decision: "approved"},
        },
      ],
    },
    run.subscriber,
  );

  assert.deepEqual(run.types(), ["RUN_STARTED", "RUN_ERROR"]);
  assert.equal(run.events.at(-1).code, "unknown_interrupt");
  assert.deepEqual(agent.calls, []);
});

test("a connect sends the conversation and follows the running turn", async () => {
  const agent = fakeAgent();
  agent.append(
    {role: "user", text: "First question", delivery: "turn"},
    answer("t1", "First answer."),
    {role: "user", text: "Second question", delivery: "turn"},
    {
      role: "event",
      type: "activity",
      turnId: "t2",
      step: 1,
      message: "Looking",
    },
  );
  const client = agUiClient(agent);
  later(() => {
    agent.append(answer("t2", "Second answer."));
  });

  await client.connectAgent();

  const texts = client.messages
    .filter((message) => message.role !== "activity")
    .map((message) => message.content);
  assert.deepEqual(texts, [
    "First question",
    "First answer.",
    "Second question",
    "Second answer.",
  ]);
  assert.deepEqual(agent.calls, []);
});

test("a connect to an idle agent finishes after the snapshot", async () => {
  const agent = fakeAgent();
  agent.append(
    {role: "user", text: "Hello", delivery: "turn"},
    answer("t1", "Hi."),
  );
  const client = agUiClient(agent);
  const run = recorder();

  await client.connectAgent({}, run.subscriber);

  assert.deepEqual(run.types(), [
    "RUN_STARTED",
    "MESSAGES_SNAPSHOT",
    "RUN_FINISHED",
  ]);
  assert.equal(client.messages.length, 2);
});

test("a steer lands in the active turn and the run follows it", async () => {
  const agent = fakeAgent();
  agent.append({role: "user", text: "Plan a trip", delivery: "turn"});
  agent.turn.steer = (message) => {
    later(() => {
      agent.append(
        {role: "user", text: message, delivery: "steer"},
        {role: "event", type: "steer", turnId: "t1", queuedMessages: 0},
        answer("t1", "A trip that includes Paris."),
      );
    });
    return true;
  };
  const client = agUiClient(agent);
  await client.connectAgent();
  client.addMessage(userMessage("Also include Paris"));

  const {result} = await client.runAgent({forwardedProps: {mode: "steer"}});

  assert.deepEqual(agent.calls, [["steer", "Also include Paris"]]);
  assert.deepEqual(result, {turnId: "t1", status: "completed"});
  const users = client.messages.filter((message) => message.role === "user");
  assert.equal(users.length, 2, "the steering message is not repeated");
});

test("a failed turn ends the run with an error", async () => {
  const agent = fakeAgent();
  agent.turn.ask = () => {
    later(() => {
      agent.append(
        answer("t1", "The model provider is unavailable.", "failed"),
      );
    });
    return {decision: "start", turnId: "t1", stats: {pendingMessages: 0}};
  };
  const client = agUiClient(agent);
  client.addMessage(userMessage("Hello"));
  const run = recorder();

  await client.runAgent({}, run.subscriber);

  const last = run.events.at(-1);
  assert.equal(last.type, "RUN_ERROR");
  assert.equal(last.code, "turn_failed");
  assert.equal(last.message, "The model provider is unavailable.");
});

test("a request that is not a RunAgentInput is rejected", () => {
  assert.throws(
    () => parseRunInput({threadId: "demo"}),
    (error) => error.status === 400,
  );
});
