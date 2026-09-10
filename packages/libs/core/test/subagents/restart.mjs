// Requires disposable Restate :19070/:18080, with :19881 free.
// Starts/kills only its own scripted-model endpoint; no provider calls.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {setTimeout} from "node:timers/promises";

const id=`subagent-restart-${Date.now()}`;
async function call(service,key,method,input) {
  const response=await fetch(`http://localhost:18080/${service}/${key}/${method}`,{
    method:"POST",...(input===undefined?{}:{headers:{"content-type":"application/json"},body:JSON.stringify(input)}),signal:AbortSignal.timeout(30000),
  });
  const text=await response.text(); assert.ok(response.ok,`${method}: ${text}`); return text?JSON.parse(text):null;
}
async function until(fn,label) {
  const end=Date.now()+30000;
  while(Date.now()<end) {const result=await fn();if(result)return result;await setTimeout(100);}
  throw Error(`Timed out: ${label}`);
}
function start() {
  const process=spawn(globalThis.process.execPath,["--import","tsx","test/subagents/endpoint.ts"],{
    env:{...globalThis.process.env,RESTATE_ADMIN_URL:"http://localhost:19070"},stdio:["ignore","pipe","pipe"],
  });
  const state={process,output:""};
  process.stdout.on("data",chunk=>state.output+=chunk);
  process.stderr.on("data",chunk=>state.output+=chunk);
  return state;
}
async function stop(state) {
  if(!state || state.process.exitCode!==null || state.process.signalCode!==null)return;
  const exited=once(state.process,"exit");state.process.kill("SIGKILL");await exited;
}
let first,second;
try {
  first=start();
  await until(()=>first.output.includes("listening on 19881"),"initial endpoint");
  const reg=await fetch("http://localhost:19070/deployments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uri:"http://host.docker.internal:19881",force:true})});
  assert.ok(reg.ok,await reg.text());
  await call("Agent",id,"setInstructions",{instructions:"INHERITED_PROFILE"});
  const {turnId}=await call("Agent",id,"ask",{message:"E2E APPROVAL"});
  const approval=await until(async()=> (await call("Agent",id,"approvals"))[0],"child approval");
  const before=await call("Agent",id,"subagents");
  assert.equal(before.length,1);
  await stop(first);
  second=start();
  await until(()=>second.output.includes("listening on 19881"),"replacement endpoint");
  assert.deepEqual(await call("Agent",id,"subagents"),before);
  assert.equal(await call("Agent",id,"resolveApproval",{approvalId:approval.approvalId,decision:"approved"}),true);
  const outcome=await until(async()=> (await call("AgentSession",id,"history",{fromSequence:1,limit:100})).entries.find(e=>e.entry.role==="assistant" && e.entry.turnId===turnId)?.entry,"parent result after restart");
  assert.equal(outcome.status,"completed");
  assert.match(outcome.text,/child evidence received/);
  const after=await call("Agent",id,"subagents");
  assert.equal(after.length,1);assert.equal(after[0].agentId,before[0].agentId);assert.equal(after[0].turnId,before[0].turnId);
  assert.equal(after[0].status,"completed");
  const history=await call("AgentSession",after[0].agentId,"history",{fromSequence:1,limit:100});
  assert.equal(history.entries.filter(e=>e.entry.type==="approval_request").length,1);
  assert.ok(second.output.includes("Replaying invocation"));
  console.log("PASS restart: child identity, pending approval, and parent result survive endpoint crash without duplicate child work");
} catch(error) {
  console.error(first?.output,second?.output);throw error;
} finally {await stop(first);await stop(second);}
