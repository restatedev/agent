import assert from "node:assert/strict";
import {test} from "node:test";
import * as restate from "@restatedev/restate-sdk-gen";
import * as history from "../../src/session/history.ts";
import {AgentSession} from "../../src/session/service.ts";
import {runHandler} from "./harness.mjs";

function fixture(ctx,state,effects,reads) {
  let seq=0;
  return new Proxy(ctx,{get(target,key) {
    if(key==="key")return "compaction-test";
    if(key==="get")return name=>{reads.push(name);return ctx.run(`get-${seq++}`,()=>structuredClone(state.get(name)??null));};
    if(key==="set")return (name,value)=>state.set(name,structuredClone(value));
    if(key==="clear")return name=>state.delete(name);
    if(key==="genericSend")return opts=>{
      effects.push(opts);
      const id=`send-${seq++}`;
      return {invocationId:ctx.run(id,()=>id)};
    };
    const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
  }});
}
function harness() {
  const state=new Map(),effects=[],reads=[];
  return {state,effects,reads,run:operation=>runHandler(ctx=>restate.execute(fixture(ctx,state,effects,reads),operation)),read:()=>runHandler(ctx=>AgentSession.object.compaction(fixture(ctx,state,effects,reads)))};
}
const message=i=>i%2===0?{role:"user",text:`message ${i}`,delivery:"turn"}:{role:"assistant",text:`message ${i}`,turnId:`turn-${i}`,status:"completed"};
const notifications=h=>h.effects.filter(e=>e.method==="publish").map(e=>e.parameter);

test("summary read is empty initially and does not scan transcript chunks",async()=>{
  const h=harness();
  assert.deepEqual((await h.read()).output,{summary:null,pending:null,lastAttempt:null});
  assert.deepEqual(h.reads,["history/meta","history/summary"]);
});

test("compaction threshold counts messages, and reservation publishes current status",async()=>{
  const h=harness();
  await h.run(restate.gen(function*(){
    const writer=yield* history.openTurn();
    yield* writer.append(...Array.from({length:31},(_,i)=>message(i)));
    yield* writer.append(...Array.from({length:40},()=>({role:"event",type:"progress",turnId:"turn",phase:"thinking"})));
    assert.equal(yield* writer.beginCompaction(),undefined);
    assert.ok(!notifications(h).includes("compaction"));
    yield* writer.append(message(31));
    const plan=yield* writer.beginCompaction();
    assert.deepEqual(plan,{baseThrough:0,through:72});
    assert.equal(yield* writer.beginCompaction(),undefined);
    assert.equal(notifications(h).filter(t=>t==="compaction").length,1);
    assert.deepEqual((yield* history.compaction()).pending,plan);
    return true;
  }));
});

test("completion notifies, preserves every history segment, and replaces only model context",async()=>{
  const h=harness();
  await h.run(restate.gen(function*(){
    const writer=yield* history.openTurn();
    yield* writer.append(...Array.from({length:32},(_,i)=>message(i)));
    const plan=yield* writer.beginCompaction();
    // A newer turn can append before the shared compactor result is applied.
    yield* writer.append(message(32));
    const before=yield* history.page(1,100);
    const chunks=[...h.state].filter(([k])=>k.startsWith("history/chunk/"));
    assert.equal(yield* history.finishCompaction({...plan,status:"completed",summary:"Earlier conversation"}),true);
    assert.deepEqual(yield* history.page(1,100),before);
    assert.deepEqual([...h.state].filter(([k])=>k.startsWith("history/chunk/")),chunks);
    assert.deepEqual(yield* history.compaction(),{
      summary:{through:32,text:"Earlier conversation"},pending:null,lastAttempt:{...plan,status:"completed"},
    });
    const next=yield* history.openTurn();
    assert.deepEqual(next.context(),{summary:"Earlier conversation",entries:[message(32)]});
    assert.equal(notifications(h).filter(t=>t==="compaction").length,2);
    return true;
  }));
  h.reads.length=0;
  assert.equal((await h.read()).output.summary.text,"Earlier conversation");
  assert.deepEqual(h.reads,["history/meta","history/summary"]);
});

test("failure is observable, retains the previous summary, and permits the next attempt",async()=>{
  const h=harness();
  await h.run(restate.gen(function*(){
    const writer=yield* history.openTurn();
    yield* writer.append(...Array.from({length:32},(_,i)=>message(i)));
    const first=yield* writer.beginCompaction();
    yield* history.finishCompaction({...first,status:"completed",summary:"Keep this summary"});
    const later=yield* history.openTurn();
    yield* later.append(...Array.from({length:32},(_,i)=>message(i+32)));
    const plan=yield* later.beginCompaction();
    assert.equal(yield* history.finishCompaction({...plan,status:"failed",error:"unavailable"}),false);
    const read=yield* history.compaction();
    assert.deepEqual(read.summary,{through:32,text:"Keep this summary"});
    assert.deepEqual(read.lastAttempt,{...plan,status:"failed",error:"unavailable"});
    assert.equal(read.pending,null);
    assert.equal((yield* history.page(1,100)).entries.length,64);
    const retry=yield* history.openTurn();
    yield* retry.append(message(64));
    assert.deepEqual(yield* retry.beginCompaction(),{baseThrough:32,through:65});
    assert.equal(notifications(h).filter(t=>t==="compaction").length,5);
    return true;
  }));
});

test("stale and duplicate compaction outcomes neither overwrite state nor publish",async()=>{
  const h=harness();
  await h.run(restate.gen(function*(){
    const writer=yield* history.openTurn();
    yield* writer.append(...Array.from({length:32},(_,i)=>message(i)));
    const plan=yield* writer.beginCompaction();
    const before=structuredClone([...h.state]), count=h.effects.length;
    assert.equal(yield* history.finishCompaction({...plan,through:31,status:"completed",summary:"stale"}),false);
    assert.deepEqual([...h.state],before);assert.equal(h.effects.length,count);
    const result={...plan,status:"completed",summary:"current"};
    yield* history.finishCompaction(result);
    const ended=structuredClone([...h.state]), endedCount=h.effects.length;
    assert.equal(yield* history.finishCompaction(result),false);
    assert.deepEqual([...h.state],ended);assert.equal(h.effects.length,endedCount);
    return true;
  }));
});
