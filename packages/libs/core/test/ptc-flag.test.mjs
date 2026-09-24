import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {test} from "node:test";
import {promisify} from "node:util";

// The flag is read at module load, so each case runs in a fresh process.
const probe = `
  const tools = await import("./src/session/tools.ts");
  const permissions = {builtin: {mode: "all"}, dynamic: {mode: "selected", names: []}, mcp: []};
  const context = tools.createAgentToolContext("agent", "turn", false, permissions);
  const catalog = tools.manifests([], [], context);
  const search = catalog.find(tool => tool.name === "searchTools");
  console.log(JSON.stringify({
    reserved: tools.names.includes("executeProgram"),
    permissionCatalog: tools.builtinCatalog.some(tool => tool.name === "executeProgram"),
    modelCatalog: catalog.some(tool => tool.name === "executeProgram"),
    searchMentionsPrograms: search.description.includes("program"),
  }));
`;

async function catalogWith(flag) {
  const env = {...process.env};
  delete env.AGENT_PTC_ENABLED;
  if (flag !== undefined) {
    env.AGENT_PTC_ENABLED = flag;
  }
  const {stdout} = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", probe],
    {cwd: new URL("..", import.meta.url), env},
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

test("AGENT_PTC_ENABLED=false hides PTC from every catalog but keeps the name reserved", async () => {
  assert.deepEqual(await catalogWith("false"), {
    reserved: true,
    permissionCatalog: false,
    modelCatalog: false,
    searchMentionsPrograms: false,
  });
  assert.deepEqual(await catalogWith(undefined), {
    reserved: true,
    permissionCatalog: true,
    modelCatalog: true,
    searchMentionsPrograms: true,
  });
});
