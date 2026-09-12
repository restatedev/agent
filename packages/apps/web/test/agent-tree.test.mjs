import assert from "node:assert/strict";
import {test} from "node:test";
import {agentSubtree, agentTree} from "../src/agent-tree.ts";
import {connectionEnabled, toggleConnection} from "../src/tool-toggles.ts";

const agents = [{agentId: "parent", name: "Parent"}, {agentId: "other", name: "Other"}, {agentId: "child", name: "Child", parentAgentId: "parent"}, {agentId: "leaf", name: "Leaf", parentAgentId: "child"}];
test("sidebar groups children under parents in stable order", () => {
  assert.deepEqual(agentTree(agents, new Set()).map(r => [r.agent.agentId, r.depth]), [["parent", 0], ["child", 1], ["leaf", 2], ["other", 0]]);
});
test("folding hides descendants but retains their IDs for unread indication and deletion", () => {
  const rows = agentTree(agents, new Set(["parent"]));
  assert.deepEqual(rows.map(r => r.agent.agentId), ["parent", "other"]);
  assert.deepEqual(rows[0].children, ["child", "leaf"]);
  assert.deepEqual([...agentSubtree(agents, "parent")], ["parent", "child", "leaf"]);
});
test("orphans and cycles neither disappear nor recurse indefinitely", () => {
  const broken = [{agentId: "a", name: "A", parentAgentId: "b"}, {agentId: "b", name: "B", parentAgentId: "a"}, {agentId: "orphan", name: "Orphan", parentAgentId: "absent"}];
  const rows = agentTree(broken, new Set());
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(r => r.agent.agentId)).size, 3);
  assert.deepEqual([...agentSubtree(broken, "a")], ["a", "b"]);
});
test("sub-agent connection toggles reflect explicit inherited defaults", () => {
  const tools = {builtin: {mode: "all"}, dynamic: {mode: "all"}, mcp: [], mcpDefault: "disabled"};
  assert.equal(connectionEnabled(tools, "notion"), false);
  const enabled = toggleConnection(tools, "notion", true);
  assert.equal(connectionEnabled(enabled, "notion"), true);
  assert.equal(connectionEnabled(enabled, "github"), false);
  assert.equal(connectionEnabled(toggleConnection(enabled, "notion", false), "notion"), false);
});
