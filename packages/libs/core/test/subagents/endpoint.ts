// Real controllers/session/tools with a deterministic model peer. No API key.
import assert from "node:assert/strict";
import {serve} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {Agent, AgentNotifications, AgentScheduler, AgentSession, Sandbox} from "../../src/index.js";
import {AgentModelRequestSchema, GuardrailDecisionSchema, GuardrailEvaluationRequestSchema, ModelResultSchema} from "../../src/gateway/model.js";

function calls(items: {toolName: string; input: unknown}[]) {
  const calls = items.map((item, i) => ({...item, toolCallId: `call-${i}`}));
  return {type: "tool_calls" as const, calls, message: {role: "assistant" as const, content: calls.map(call => ({type: "tool-call" as const, ...call}))}, activity: "Running the scripted verification"};
}

const Gateway = restate.service({
  name: "ModelGateway",
  handlers: {
    complete: restate.schemas({input: AgentModelRequestSchema, output: ModelResultSchema}, function* (request) {
      const serialized = JSON.stringify(request.messages);
      const child = request.messages.some(m => typeof m.content === "string" && m.content.startsWith("[Delegated task]"));
      const usedTool = request.messages.some(m => m.role === "tool");
      if (child) {
        assert.ok(!serialized.includes("PRIVATE_MAIN_HISTORY"), "child must not receive the parent transcript");
        assert.equal(request.instructions, "INHERITED_PROFILE");
        assert.ok(!request.tools.some(t => ["runSubagent", "manageMemory", "scheduleMessage"].includes(t.name)));
        if (!usedTool && request.tools.length) {
          if (serialized.includes("CHILD_WAIT")) return calls([{toolName:"sleep", input:{durationSeconds:300}}]);
          if (serialized.includes("CHILD_APPROVAL")) return calls([{toolName:"humanApproval",input:{question:"Approve this child task?"}}]);
          return calls([{toolName:"getWeather",input:{city:serialized.includes("Paris") ? "Paris" : "Berlin"}}]);
        }
        return {type:"text" as const,content:"CHILD_RESULT: verified delegated work"};
      }
      if (!usedTool && request.tools.length) {
        const first = [...request.messages].reverse().find(m=>m.role==="user" && typeof m.content==="string")?.content;
        if (typeof first === "string" && first.includes("E2E")) {
          const task = first.includes("WAIT") ? "CHILD_WAIT" : first.includes("APPROVAL") ? "CHILD_APPROVAL" : "CHILD_WEATHER";
          const count = first.includes("PARALLEL") || first.includes("PTC") ? 2 : 1;
          const specs = Array.from({length:count},(_,i)=>({name:i ? "Paris worker" : "Berlin worker",task:`${task} ${i ? "Paris" : "Berlin"}`,context:"Only this explicit brief",tools:null}));
          if(first.includes("RACE")) return calls([{toolName:"executeProgram",input:{source:`async tools => Promise.race([tools.runSubagent(${JSON.stringify({...specs[0],task:"CHILD_WAIT"})}), tools.sleep({durationSeconds:1})])`}}]);
          if(first.includes("PTC")) return calls([{toolName:"executeProgram",input:{source:`async tools => Promise.all(${JSON.stringify(specs)}.map(spec => tools.runSubagent(spec)))`}}]);
          return calls(specs.map(input=>({toolName:"runSubagent",input})));
        }
      }
      return {type:"text" as const,content:serialized.includes("CHILD_RESULT") ? "PARENT_RESULT: child evidence received" : "Parent candidate response"};
    }),
    evaluateGuardrails: restate.schemas({input:GuardrailEvaluationRequestSchema,output:GuardrailDecisionSchema},function* (request) {
      const policy=request.guardrails.find(p=>p.id==="child-weather-approval");
      if(policy && request.action.type==="tool_calls" && request.action.calls.some(c=>c.toolName==="getWeather")) return {decision:"require_approval" as const,guardrailId:policy.id,reason:"Inherited guardrail",question:"Allow the child weather lookup?"};
      return {decision:"allow" as const};
    }),
  },
});

serve({port:19881,services:[Agent,AgentSession,AgentNotifications,AgentScheduler,Sandbox,Gateway]});
