import assert from "node:assert/strict";
import {test} from "node:test";

import {AgentClientError, createAgentClient} from "../dist/index.js";

function entry(sequence) {
  return {
    sequence,
    entry: {role: "user", text: `m${sequence}`, delivery: "turn"},
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"content-type": "application/json"},
  });
}

// A fake ingress: `routes` maps a handler name to a function of its JSON body
// and the request headers. Every request is recorded.
function fakeIngress(t, routes) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const handler = new URL(url).pathname.split("/").at(-1);
    const body = init.body
      ? JSON.parse(new TextDecoder().decode(init.body))
      : undefined;
    const headers = new Headers(init.headers);
    requests.push({handler, body, headers});
    return routes[handler](body, headers);
  });
  return requests;
}

function client() {
  return createAgentClient({
    ingressUrl: "http://ingress.test/",
    agentId: "demo",
    retry: false,
  });
}

test("follow drains history pages, then waits for a notification before reading again", async (t) => {
  const pages = [
    {entries: [entry(1), entry(2)], nextSequence: 3},
    {entries: [], nextSequence: 3},
    {entries: [entry(3)], nextSequence: 4},
  ];
  const requests = fakeIngress(t, {
    history: () => json(pages.shift() ?? {entries: [], nextSequence: 4}),
    watch: () => json({revision: 7, versions: {history: 7}}),
  });
  const abort = new AbortController();

  const seen = [];
  for await (const item of client().follow({signal: abort.signal})) {
    seen.push(item.sequence);
    if (item.sequence === 3) abort.abort();
  }

  assert.deepEqual(seen, [1, 2, 3]);
  const handlers = requests.map((request) => request.handler);
  assert.deepEqual(handlers, ["history", "history", "watch", "history"]);
  assert.deepEqual(requests[1].body, {fromSequence: 3, limit: 100});
  assert.equal(requests[2].body.afterRevision, 0);
  assert.ok(
    requests[2].headers.get("idempotency-key"),
    "each wait window has an idempotency key",
  );
});

test("follow stops on an ingress rejection instead of retrying it", async (t) => {
  fakeIngress(t, {
    history: () => json({message: "agent retired"}, 403),
  });

  const followed = client().follow();

  await assert.rejects(followed.next(), (error) => {
    assert.ok(error instanceof AgentClientError);
    assert.equal(error.status, 403);
    assert.equal(error.message, "agent retired");
    return true;
  });
});
