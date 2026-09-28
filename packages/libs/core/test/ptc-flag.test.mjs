import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {test} from "node:test";
import {promisify} from "node:util";

// The catalogs read agentConfig.programTool once, at module load, so each case
// sets it in a fresh process before the tool registry is loaded.
const probe = (programTool) => `
  const {agentConfig} = await import("./src/agent-config.ts");
  agentConfig.programTool = ${programTool};
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

async function catalogWith(programTool) {
  const {stdout} = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", probe(programTool)],
    {cwd: new URL("..", import.meta.url)},
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

test("programTool switches PTC in and out of every catalog; the name stays reserved", async () => {
  assert.deepEqual(await catalogWith(false), {
    reserved: true,
    permissionCatalog: false,
    modelCatalog: false,
    searchMentionsPrograms: false,
  });
  assert.deepEqual(await catalogWith(true), {
    reserved: true,
    permissionCatalog: true,
    modelCatalog: true,
    searchMentionsPrograms: true,
  });
});
