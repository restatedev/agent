import assert from "node:assert/strict";
import {test} from "node:test";
import {localSandboxProvider} from "../../src/sandbox/local-provider.ts";

const options = () => ({signal: new AbortController().signal});

test("local commands do not inherit service credentials from the process environment", async t => {
  const before = process.env.TEST_SERVICE_SECRET;
  process.env.TEST_SERVICE_SECRET = "must-not-leak";
  const ref = await localSandboxProvider.provision({agentId: "env-probe", ...options()});
  t.after(async () => {
    if (before === undefined) delete process.env.TEST_SERVICE_SECRET;
    else process.env.TEST_SERVICE_SECRET = before;
    await localSandboxProvider.destroy(ref, options());
  });
  const client = localSandboxProvider.connect(ref);
  const result = await client.executeCommand({command: "env"}, options());
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /must-not-leak|TEST_SERVICE_SECRET|OPENAI_API_KEY/);
  const vars = Object.fromEntries(result.stdout.trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
  assert.equal(vars.HOME, ref.root);
  assert.ok(vars.PATH, "ordinary tools stay on PATH");
  // Commands still find standard tools.
  assert.equal((await client.executeCommand({command: "echo ok | tr a-z A-Z"}, options())).stdout, "OK\n");
});
