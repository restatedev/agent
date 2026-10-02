import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {test} from "node:test";
import {promisify} from "node:util";

// agentConfig reads the model variables once, at module load, so each case
// loads it in a fresh process with its own environment.
const probe = `
  const {agentConfig} = await import("./src/agent-config.ts");
  console.log(JSON.stringify(agentConfig.models));
`;

async function modelsWith(env) {
  const base = {...process.env};
  for (const name of ["AGENT_MODEL", "GUARDRAIL_MODEL", "COMPACTOR_MODEL"])
    delete base[name];
  const {stdout} = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", probe],
    {cwd: new URL("..", import.meta.url), env: {...base, ...env}},
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

test("the model variables override the configured models", async () => {
  const defaults = await modelsWith({});
  assert.deepEqual(
    await modelsWith({
      AGENT_MODEL: "anthropic:claude-sonnet-5",
      GUARDRAIL_MODEL: " xai:grok-5 ",
      COMPACTOR_MODEL: "google:gemini-3.8-flash",
    }),
    {
      agent: "anthropic:claude-sonnet-5",
      guardrail: "xai:grok-5",
      compactor: "google:gemini-3.8-flash",
    },
  );
  assert.deepEqual(
    await modelsWith({
      AGENT_MODEL: "deepseek:deepseek-chat",
      COMPACTOR_MODEL: "",
    }),
    {...defaults, agent: "deepseek:deepseek-chat"},
  );
});
