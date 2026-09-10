// Requires a disposable Restate at :19070/:18080 and the test endpoint :19881.
// It creates only prefixed test Agents; no provider keys or live model calls.
import assert from "node:assert/strict";
import {setTimeout} from "node:timers/promises";

const ingress="http://localhost:18080";
const admin="http://localhost:19070";
const prefix=`subagent-e2e-${Date.now()}`;
async function call(service,key,method,input) {
  const r=await fetch(`${ingress}/${service}/${key}/${method}`,{method:"POST",...(input===undefined?{}:{headers:{"content-type":"application/json"},body:JSON.stringify(input)}),signal:AbortSignal.timeout(15000)});
  const text=await r.text(); assert.ok(r.ok,`${method}: ${r.status} ${text}`); return text?JSON.parse(text):null;
}
async function until(fn,label,ms=25000) {
  const end=Date.now()+ms;
  while(Date.now()<end) { const result=await fn(); if(result) return result; await setTimeout(100); }
  throw Error(`Timed out: ${label}`);
}
async function history(id) { return (await call("AgentSession",id,"history",{fromSequence:1,limit:100})).entries; }
async function final(id,turnId) { return until(async()=> (await history(id)).find(x=>x.entry.role==="assistant" && x.entry.turnId===turnId)?.entry,"parent final"); }
async function initialize(name) {
  const id=`${prefix}-${name}`;
  await call("Agent",id,"setInstructions",{instructions:"INHERITED_PROFILE"});
  return id;
}
async function run(name, prompt) {
  const id=await initialize(name);
  const started=await call("Agent",id,"ask",{message:prompt});
  return {id,turnId:started.turnId};
}
const active = child=>["running","starting","cancelling"].includes(child.status);
const list=id=>call("Agent",id,"subagents");

const reg=await fetch(`${admin}/deployments`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uri:"http://host.docker.internal:19881",force:true})});
assert.ok(reg.ok,await reg.text());

for(const kind of ["PARALLEL","PTC"]) {
  const id=await initialize(kind);
  const old=await call("Agent",id,"ask",{message:"PRIVATE_MAIN_HISTORY"}); await final(id,old.turnId);
  const {turnId}=await call("Agent",id,"ask",{message:`E2E ${kind}`});
  const result=await final(id,turnId);
  assert.equal(result.status,"completed"); assert.match(result.text,/child evidence received/);
  const children=await until(async()=>{const c=await list(id);return c.length===2 && c.every(x=>!active(x))?c:false;},"two settled children");
  assert.equal(new Set(children.map(c=>c.agentId)).size,2);
  for(const child of children) {
    assert.equal(child.status,"completed");
    const entries=await history(child.agentId);
    assert.ok(entries.some(x=>x.entry.type==="tools" && x.entry.calls.some(c=>c.name==="getWeather")));
    assert.ok(!JSON.stringify(entries).includes("PRIVATE_MAIN_HISTORY"));
  }
  assert.ok((await call("AgentNotifications",id,"snapshot")).versions.subagents>0);
  console.log(`PASS ${kind}: parent/child results, isolated transcripts, inherited config, notifications`);
}

for(const kind of ["APPROVAL","GUARD"]) {
  const id=await initialize(kind);
  if(kind==="GUARD") await call("Agent",id,"setGuardrails",{guardrails:[{id:"child-weather-approval",rule:"Ask before a weather lookup"}]});
  const {turnId}=await call("Agent",id,"ask",{message:`E2E ${kind}`});
  const approval=await until(async()=> (await call("Agent",id,"approvals"))[0],"child approval on owner");
  const child=(await list(id))[0];
  assert.equal(approval.agentId,child.agentId); assert.equal(approval.turnId,child.turnId);
  assert.notEqual(child.turnId,turnId);
  assert.equal(await call("Agent",id,"resolveApproval",{approvalId:approval.approvalId,decision:"approved"}),true);
  assert.equal((await final(id,turnId)).status,"completed");
  console.log(`PASS ${kind}: owner UI request routes decision to child signal`);
}

for(const kind of ["parent","child","external","external-child"]) {
  const {id,turnId}=await run(`stop-${kind}`,"E2E WAIT");
  const child=await until(async()=> (await list(id)).find(c=>active(c) && c.turnId),"running child");
  await until(async()=> (await history(child.agentId)).some(x=>x.entry.type==="progress" && x.entry.phase==="waiting"),"child durable sleep");
  if(kind==="child") {
    const rejected=await fetch(`${ingress}/Agent/${child.agentId}/interrupt`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({reason:"Replacement must not run",message:"another task"})});
    assert.equal(rejected.status,400);
    const profileRejected=await fetch(`${ingress}/Agent/${child.agentId}/setInstructions`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({instructions:"Override inherited policy"})});
    assert.equal(profileRejected.status,400);
  }
  if(kind==="parent") await call("Agent",id,"interrupt",{reason:"Stop verification"});
  else if(kind==="child") await call("Agent",id,"cancelSubagent",{parentTurnId:turnId,toolCallId:child.toolCallId});
  else {
    const r=await fetch(`${admin}/invocations/${kind==="external-child"?child.turnId:turnId}/cancel`,{method:"PATCH"});
    assert.ok(r.ok,await r.text());
  }
  if(kind==="external") {
    await until(async()=> (await history(id)).some(x=>x.entry.type==="interrupt" && x.entry.turnId===turnId),"external cancellation boundary");
  } else {
    const outcome=await final(id,turnId);
    assert.equal(outcome.status,kind==="child"||kind==="external-child"?"completed":"interrupted");
  }
  const ended=await until(async()=> (await list(id)).find(c=>c.agentId===child.agentId && !active(c)),"child stopped");
  assert.equal(ended.status,"interrupted");
  assert.equal((await call("Agent",id,"approvals")).length,0);
  console.log(`PASS stop-${kind}: child joined/stopped and approvals cleaned`);
}

{
  const {id,turnId}=await run("race","E2E RACE");
  assert.equal((await final(id,turnId)).status,"completed");
  const child=await until(async()=> (await list(id)).find(c=>!active(c)),"race loser stopped");
  assert.equal(child.status,"interrupted");
  console.log("PASS PTC race: losing child stopped before parent completion");
}

console.log(`PASS all sub-agent E2E scenarios (${prefix})`);
