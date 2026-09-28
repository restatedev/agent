import assert from "node:assert/strict";
import {test} from "node:test";

import {agentConfig} from "../src/agent-config.ts";
import {agentSystemPrompt} from "../src/model/provider.ts";
import * as tools from "../src/session/tools.ts";

const allTools = {
  builtin: {mode: "all"},
  dynamic: {mode: "selected", names: []},
  mcp: [],
};

function catalog(builtin, webSearchEnabled = true) {
  const permissions = {...allTools, builtin};
  return tools.manifests([], [], {webSearchEnabled, permissions});
}

test("the runtime offers every configured tool, plus searchTools", () => {
  const offered = catalog({mode: "all"}).map(({name}) => name);
  for (const tool of agentConfig.tools) assert.ok(offered.includes(tool.name));
  assert.ok(offered.includes("searchTools"));
});

test("a tool's instructions reach the system prompt only while it is offered", () => {
  const withMemory = agentSystemPrompt({
    messages: [],
    tools: catalog({mode: "all"}),
  });
  assert.ok(withMemory.startsWith(agentConfig.baseInstructions));
  assert.match(withMemory, /search this agent's memories with searchMemories/);
  assert.match(withMemory, /Be selective about remembering/);

  const withoutMemory = agentSystemPrompt({
    messages: [],
    tools: catalog({mode: "selected", names: ["getWeather"]}),
  });
  assert.equal(withoutMemory, agentConfig.baseInstructions);
});

test("persistent user instructions follow the base and tool instructions", () => {
  const prompt = agentSystemPrompt({
    instructions: "Answer in French.",
    messages: [],
    tools: [],
  });
  assert.equal(
    prompt,
    [
      agentConfig.baseInstructions,
      "",
      "[Persistent user instructions]",
      "These instructions apply across turns.",
      "Answer in French.",
    ].join("\n"),
  );
});

test("a tool's own availability check hides it from the catalog", () => {
  const names = catalog({mode: "all"}, false).map(({name}) => name);
  assert.ok(!names.includes("webSearch"));
  assert.ok(names.includes("getWeather"));
});
