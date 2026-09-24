import assert from "node:assert/strict";
import {test} from "node:test";

import {localSandboxProvider} from "../src/sandbox/local-provider.ts";

const options = () => ({signal: new AbortController().signal});

// `env` output as {NAME: value}.
function parseEnv(stdout) {
  const vars = {};
  for (const line of stdout.trim().split("\n")) {
    const separator = line.indexOf("=");
    vars[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return vars;
}

function setEnv(t, name, value) {
  const before = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (before === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = before;
    }
  });
}

test("local commands do not inherit service credentials from the process environment", async (t) => {
  setEnv(t, "TEST_SERVICE_SECRET", "must-not-leak");
  const ref = await localSandboxProvider.provision({
    agentId: "env-probe",
    ...options(),
  });
  t.after(() => localSandboxProvider.destroy(ref, options()));
  const client = localSandboxProvider.connect(ref);

  const result = await client.executeCommand({command: "env"}, options());

  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(
    result.stdout,
    /must-not-leak|TEST_SERVICE_SECRET|OPENAI_API_KEY/,
  );
  const vars = parseEnv(result.stdout);
  assert.equal(vars.HOME, ref.root);
  assert.ok(vars.PATH, "ordinary tools stay on PATH");

  const piped = await client.executeCommand(
    {command: "echo ok | tr a-z A-Z"},
    options(),
  );
  assert.equal(piped.stdout, "OK\n");
});
