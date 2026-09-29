import assert from "node:assert/strict";
import {test} from "node:test";

import {TerminalError} from "@restatedev/restate-sdk";

import {agentConfig} from "../src/agent-config.ts";
import {completeAgent} from "../src/model/provider.ts";

// The configured agent model is an OpenAI model, so these calls go through
// the real OpenAI provider with fetch replaced: nothing leaves the process.
const request = {messages: [{role: "user", content: "Hello"}], tools: []};
const signal = () => new AbortController().signal;

function setEnv(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

function respondWith(t, status) {
  return t.mock.method(globalThis, "fetch", async () =>
    Response.json({error: {message: `status ${status}`}}, {status}),
  );
}

test("a missing API key fails the call terminally before any request", async (t) => {
  setEnv(t, "OPENAI_API_KEY", undefined);
  const fetch = respondWith(t, 500);

  await assert.rejects(completeAgent(request, signal()), (error) => {
    assert.ok(error instanceof TerminalError);
    assert.match(error.message, /OPENAI_API_KEY/);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 0);
});

test("a rejected request is terminal and throttling stays retryable", async (t) => {
  setEnv(t, "OPENAI_API_KEY", "fixture-not-a-real-api-key");

  const rejected = respondWith(t, 400);
  await assert.rejects(completeAgent(request, signal()), (error) => {
    assert.ok(error instanceof TerminalError);
    assert.match(error.message, /model provider rejected the request/);
    return true;
  });
  // Restate owns retries, so the provider makes exactly one attempt.
  assert.equal(rejected.mock.callCount(), 1);
  // The provider-neutral reasoning level reaches OpenAI as its own setting,
  // and OpenAI stores nothing on its side.
  const [url, init] = rejected.mock.calls[0].arguments;
  assert.match(String(url), /\/responses$/);
  const body = JSON.parse(init.body);
  assert.equal(body.reasoning?.effort, "low");
  assert.equal(body.store, false);
  rejected.mock.restore();

  respondWith(t, 429);
  await assert.rejects(completeAgent(request, signal()), (error) => {
    assert.ok(!(error instanceof TerminalError));
    return true;
  });
});

test("a model ID without a known provider fails terminally before any request", async (t) => {
  const fetch = respondWith(t, 500);
  const configured = agentConfig.models.agent;
  t.after(() => {
    agentConfig.models.agent = configured;
  });

  for (const id of ["gpt-5.6-luna", "mistral:large", "openai:", ":gpt"]) {
    agentConfig.models.agent = id;
    await assert.rejects(completeAgent(request, signal()), (error) => {
      assert.ok(error instanceof TerminalError);
      assert.match(error.message, /must be "provider:model"/);
      return true;
    });
  }
  assert.equal(fetch.mock.callCount(), 0);
});
