import assert from "node:assert/strict";
import {test} from "node:test";
import {allowsUserAgentMutation} from "../src/server/agent-mutation-policy.ts";

test("sub-agent API permits only interrupt, not messages, configuration or indirect writes", () => {
  const child = {agentId: "child", name: "Child", parentAgentId: "parent"};
  assert.equal(allowsUserAgentMutation(child, "interrupt"), true);
  for (const operation of ["ask", "steer", "tools", "instructions", "guardrails", "schedule", "cancel-schedule", "resolve-approval", "start-mcp-authorization", "complete-mcp-bearer-authorization", "delete-agent", "startDelegatedTurn", "startSubAgentTask"])
    assert.equal(allowsUserAgentMutation(child, operation), false, operation);
  assert.equal(allowsUserAgentMutation({agentId: "parent", name: "Parent"}, "ask"), true);
});
