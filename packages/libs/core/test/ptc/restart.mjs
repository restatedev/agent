// Requires a disposable Restate server at :19070 (admin) / :18080 (ingress).
// The server must reach this host at host.docker.internal:19880.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {setTimeout} from "node:timers/promises";

const source = `async tools => {
  const order = [];
  const branches = ['a', 'b'].map(async key => {
    const item = await tools.lookup({key});
    const score = await tools.score(item);
    order.push(key);
    return {key, score};
  });
  const winner = await Promise.race(branches);
  const results = await Promise.all(branches);
  await tools.checkpoint(winner);
  return {winner, results, order};
}`;

function start() {
  const process = spawn(
    globalThis.process.execPath,
    ["--import", "tsx", "test/ptc/restart-service.ts"],
    {stdio: ["ignore", "pipe", "pipe"]},
  );
  const state = {process, output: ""};
  process.stdout.on("data", (chunk) => {
    state.output += chunk;
  });
  process.stderr.on("data", (chunk) => {
    state.output += chunk;
  });
  return state;
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 20_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await setTimeout(50);
  }
}
async function stop(state) {
  if (
    !state ||
    state.process.exitCode !== null ||
    state.process.signalCode !== null
  )
    return;
  const exited = once(state.process, "exit");
  state.process.kill("SIGKILL");
  await exited;
}

let first, second;
try {
  first = start();
  await waitFor(
    () => first.output.includes("listening on 19880"),
    "first endpoint startup",
  );
  const registration = await fetch("http://127.0.0.1:19070/deployments", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({uri: "http://host.docker.internal:19880"}),
  });
  assert.ok(registration.ok, await registration.text());
  const result = fetch("http://127.0.0.1:18080/PTCRestart/execute", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({source}),
    signal: AbortSignal.timeout(30_000),
  });
  // Keep a handler attached even if readiness or restart itself fails.
  result.catch(() => {});
  await waitFor(
    () => first.output.includes("PTC_CHECKPOINT:"),
    "recorded race winner",
  );
  assert.ok(
    first.output.includes('PTC_CHECKPOINT:{"key":"b","score":140}'),
    first.output,
  );
  await stop(first);
  second = start();
  await waitFor(
    () => second.output.includes("listening on 19880"),
    "replacement endpoint startup",
  );
  const response = await result;
  const output = await response.json();
  assert.ok(response.ok, JSON.stringify(output));
  assert.deepEqual(output, {
    winner: {key: "b", score: 140},
    results: [
      {key: "a", score: 80},
      {key: "b", score: 140},
    ],
    order: ["b", "a"],
  });
  assert.ok(
    second.output.includes('PTC_CHECKPOINT:{"key":"b","score":140}'),
    second.output,
  );
  assert.ok(!second.output.includes("PTC_EFFECT:lookup"), second.output);
  assert.ok(!second.output.includes("PTC_EFFECT:score"), second.output);
  console.log(
    "PASS: killed the endpoint at checkpoint; restart preserved the race winner, branch order, and result without rerunning recorded lookups or scores.",
  );
} catch (error) {
  console.error(first?.output, second?.output);
  throw error;
} finally {
  await stop(first);
  await stop(second);
}
