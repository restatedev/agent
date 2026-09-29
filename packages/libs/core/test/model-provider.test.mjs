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

test("each provider sends the call to its own endpoint", async (t) => {
  const configured = agentConfig.models.agent;
  t.after(() => {
    agentConfig.models.agent = configured;
  });
  setEnv(t, "ANTHROPIC_API_KEY", "fixture-not-a-real-api-key");
  setEnv(t, "GOOGLE_GENERATIVE_AI_API_KEY", "fixture-not-a-real-api-key");
  setEnv(t, "XAI_API_KEY", "fixture-not-a-real-api-key");
  setEnv(t, "DEEPSEEK_API_KEY", "fixture-not-a-real-api-key");
  setEnv(t, "OPENAI_COMPATIBLE_BASE_URL", "http://localhost:11434/v1");

  const endpoints = {
    "anthropic:claude-sonnet-5": "https://api.anthropic.com/v1/messages",
    "google:gemini-3.8-flash":
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    "xai:grok-4": "https://api.x.ai/v1/responses",
    // Strict tool schemas need DeepSeek's beta endpoint.
    "deepseek:deepseek-chat": "https://api.deepseek.com/beta/chat/completions",
    // Everything after the provider is the model name, colons included.
    "openai-compatible:qwen3:32b": "http://localhost:11434/v1/chat/completions",
  };
  for (const [id, endpoint] of Object.entries(endpoints)) {
    const fetch = respondWith(t, 400);
    agentConfig.models.agent = id;
    await assert.rejects(completeAgent(request, signal()), TerminalError);
    assert.equal(String(fetch.mock.calls[0].arguments[0]), endpoint);
    fetch.mock.restore();
  }
});

test("an OpenAI-compatible model without a base URL fails terminally", async (t) => {
  const configured = agentConfig.models.agent;
  t.after(() => {
    agentConfig.models.agent = configured;
  });
  setEnv(t, "OPENAI_COMPATIBLE_BASE_URL", undefined);
  const fetch = respondWith(t, 500);

  agentConfig.models.agent = "openai-compatible:qwen3:32b";
  await assert.rejects(completeAgent(request, signal()), (error) => {
    assert.ok(error instanceof TerminalError);
    assert.match(error.message, /OPENAI_COMPATIBLE_BASE_URL/);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 0);
});
