import assert from "node:assert/strict";
import {test} from "node:test";
import * as durable from "@restatedev/restate-sdk-gen";
import {Agent} from "../../src/agent/service.ts";
import * as children from "../../src/agent/subagents.ts";
import * as tools from "../../src/session/tools.ts";
import {runSubagent} from "../../src/session/subagents.ts";
import {subagentId, subagentTools} from "../../src/subagent.ts";
import {runHandler} from "./harness.mjs";

const profile = {instructions:"Inherited instructions", memories:[], guardrails:[{id:"policy",rule:"No writes"}], mcpServers:[], webSearchEnabled:true};
const spec = {name:"Research", task:"Find evidence", context:"Explicit background", tools:null};
const parentTurn = {id:"parent-turn", steeringBatches:[]};
const request = call => ({parentTurnId:parentTurn.id, toolCallId:call, profile, spec, availableTools:["getWeather","runSubagent","manageMemory","executeProgram"]});

function fixture(ctx, state = new Map(), effects = [], options = {}) {
  let seq=0;
  const sends = new Map();
  return new Proxy(ctx, {get(target,key) {
    if(key==="key") return options.key ?? "owner";
    if(key==="get") return name=>ctx.run(`get-${seq++}`,()=>structuredClone(state.get(name) ?? null));
    if(key==="set") return (name,value)=>state.set(name,structuredClone(value));
    if(key==="clear") return name=>state.delete(name);
    if(key==="genericSend") return opts=>{
      const id=`send-${seq++}`; sends.set(id,opts); effects.push(opts);
      return {invocationId:ctx.run(`${id}-id`,()=>id)};
    };
    if(key==="attach") return id=>ctx.run(`attach-${seq++}`,()=>{
      const sent=sends.get(id);
      if(options.attach) return options.attach(id,sent);
      assert.equal(sent?.method,"startAttached");
      return `turn-${sent.key}`;
    });
    if(key==="invocation") return id=>({signal:name=>({resolve:value=>effects.push({signal:name,id,value})})});
    const value=Reflect.get(target,key);
    return typeof value==="function" ? value.bind(target) : value;
  }});
}

test("child identity and capability narrowing are deterministic",()=>{
  assert.equal(subagentId("a","t","c"),subagentId("a","t","c"));
  assert.notEqual(subagentId("a","t","c"),subagentId("a","t2","c"));
  assert.deepEqual(subagentTools(["getWeather","runSubagent","manageMemory","scheduleMessage"],null),["getWeather"]);
  assert.throws(()=>subagentTools(["getWeather"],["writeFile"]));
  assert.throws(()=>subagentTools(["runSubagent"],["runSubagent"]));
});

test("owner registry deduplicates starts, bounds concurrency, and rejects stale results",async()=>{
  const state=new Map(),effects=[];
  await runHandler(ctx=>durable.execute(fixture(ctx,state,effects),durable.gen(function*(){
    for(const id of ["a","b","c"]) assert.equal((yield* children.start(request(id),[])).accepted,true);
    assert.equal((yield* children.start(request("a"),[])).accepted,true);
    assert.equal((yield* children.start(request("d"),[])).accepted,false);
    const [first]=yield* children.list();
    assert.equal(yield* children.finish({...first,agentId:"wrong"},{turnId:first.turnId,status:"completed",response:"bad",consumedSteering:0}),false);
    assert.equal(yield* children.finish(first,{turnId:first.turnId,status:"completed",response:"x".repeat(20_000),consumedSteering:0}),true);
    assert.equal((yield* children.start(request("d"),[])).accepted,true);
    assert.equal((yield* children.list())[0].response.length,16_000);
    return true;
  })));
  assert.equal(effects.filter(e=>e.method==="startAttached").length,4);
  const childInput=effects.find(e=>e.method==="startAttached").parameter.request;
  assert.deepEqual(childInput.guardrails,profile.guardrails);
  assert.equal(childInput.instructions,profile.instructions);
  assert.deepEqual(childInput.attached.allowedTools,["getWeather","executeProgram"]);
  assert.equal(childInput.entries.length,1);
  assert.match(childInput.entries[0].text,/Explicit background/);
});

test("cancellation tombstone blocks a late start; total budget is not reset by completion",async()=>{
  await runHandler(ctx=>durable.execute(fixture(ctx),durable.gen(function*(){
    yield* children.cancel(request("cancelled"));
    assert.equal((yield* children.start(request("cancelled"),[])).accepted,false);
    for(let n=0;n<7;n++) {
      const started=yield* children.start(request(String(n)),[]);
      assert.equal(started.accepted,true);
      yield* children.finish(started.child,{status:"completed",turnId:started.child.turnId,response:"done",consumedSteering:0});
    }
    assert.equal((yield* children.start(request("ninth"),[])).accepted,false);
    return true;
  })));
});

test("child catalogs and direct dispatcher enforce restrictions including PTC",async()=>{
  const context=tools.createAgentToolContext("child","child-turn",true,{...profile,mcpCredentials:[],entries:[],attached:{ownerAgentId:"owner",parentTurnId:"parent-turn",toolCallId:"a",name:"test",allowedTools:["getWeather","executeProgram","runSubagent","manageMemory","scheduleMessage"]}});
  assert.deepEqual(tools.manifests([],[],context).map(t=>t.name).sort(),["executeProgram","getWeather"]);
  assert.equal(tools.toolApprovalId(context,"approval"),"child-turn:approval");
  const result=await runHandler(ctx=>durable.execute(ctx,durable.gen(function*(){
    const denied=yield* tools.execute({toolCallId:"x",toolName:"manageMemory",input:{}},context,[],[]);
    assert.equal(denied.status,"failed");
    return yield* tools.execute({toolCallId:"p",toolName:"executeProgram",input:{source:"async tools => ({delegate:typeof tools.runSubagent, memory:typeof tools.manageMemory, search:typeof tools.webSearch})"}},context,[],[],{transcript:{*append(){}},step:1,*guard(){},*cancelPending(){throw Error("unused");}});
  })));
  assert.deepEqual(JSON.parse(result.output.result),{delegate:"undefined",memory:"undefined",search:"undefined"});
});

test("child profile persistence never copies tokens, and owner validates exact waiting turns",async()=>{
  const server={id:"test",type:"http",url:"https://mcp.example/test",protocol:"stateless",auth:{type:"bearer"}};
  const inherited={...profile,mcpServers:[server]};
  const state=new Map([["turn",parentTurn],["profile/mcp-servers",[server]]]);
  const effects=[];
  const invoke=(method,input)=>runHandler(ctx=>Agent.object[method](fixture(ctx,state,effects),input));
  const started=(await invoke("startSubagent",{...request("auth"),profile:inherited})).output;
  assert.equal(started.accepted,true);
  const turnId=started.child.turnId;
  assert.equal((await invoke("requestApproval",{approvalId:`${turnId}:a`,turnId,question:"Allow?"})).output,true);
  assert.equal(state.get("approvals")[0].agentId,started.child.agentId);
  assert.equal((await invoke("requestApproval",{approvalId:"fake",turnId:"unowned",question:"Allow?"})).output,false);
  const auth={authRequestId:`${turnId}:auth`,turnId,serverId:"test",authType:"bearer",reason:"unauthorized"};
  assert.equal((await invoke("requestMcpAuthorization",auth)).output.agentId,started.child.agentId);
  assert.equal((await invoke("completeMcpBearerAuthorization",{authRequestId:auth.authRequestId,accessToken:"fixture-token"})).output,true);
  assert.equal(state.get("mcp/bearer-credentials")[0].accessToken,"fixture-token");
  assert.ok(effects.some(e=>e.id===turnId && e.signal?.startsWith("mcp-authorization-")));
  await invoke("cancelSubagent",request("auth"));
  assert.deepEqual(state.get("approvals")??[],[]);
  assert.equal((await invoke("resolveApproval",{approvalId:`${turnId}:a`,decision:"approved"})).output,false);
  assert.equal((await invoke("requestMcpAuthorization",auth)).output,null);
  const childState=new Map();
  await runHandler(ctx=>durable.execute(fixture(ctx,childState),durable.gen(function*(){
    children.rememberParent({...inherited,mcpCredentials:[{serverId:"test",accessToken:"do-not-store"}],entries:[],attached:{ownerAgentId:"owner",parentTurnId:"parent-turn",toolCallId:"auth",name:"Auth child",allowedTools:[]}});
    return true;
  })));
  assert.ok(!JSON.stringify([...childState]).includes("do-not-store"));
});

test("attached tool returns only bounded child outcome and replays without restarting it",async()=>{
  const attempt=async replay=>{
    const effects=[];
    const result=await runHandler(ctx=>durable.execute(fixture(ctx,new Map(),effects,{attach:(id,sent)=>{
      if(sent?.method==="startSubagent") return {accepted:true,child:{agentId:"child",name:"Research",turnId:"child-turn"}};
      assert.equal(id,"child-turn");
      return {status:"stopped",turnId:id,response:"partial result",reason:"step limit",consumedSteering:0};
    }}),runSubagent(spec,{agentId:"owner",turnId:"parent-turn",toolCallId:"a"},profile,["getWeather"])),{replay});
    assert.equal(effects.filter(e=>e.method==="startSubagent").length,1);
    return result;
  };
  const first=await attempt([]);
  const replay=await attempt(first.journal);
  assert.deepEqual(replay.output,first.output);
  assert.deepEqual(JSON.parse(first.output.result),{agentId:"child",name:"Research",status:"stopped",response:"partial result",reason:"step limit"});
});

test("attached agents cannot queue replacement work or dispatch missed steering as another turn",async()=>{
  const attached={ownerAgentId:"owner",parentTurnId:"parent-turn",toolCallId:"child",name:"Child",allowedTools:[]};
  const state=new Map([["subagents/parent",{attached,profile}],["turn",{id:"child-turn",steeringBatches:[{queued:[],message:"late steer"}]}]]);
  const effects=[];
  const invoke=(method,input)=>runHandler(ctx=>Agent.object[method](fixture(ctx,state,effects,{key:"child"}),input));
  // A memory update is a rejected domain action, not an inherited-profile write.
  assert.equal((await invoke("updateMemory",{turnId:"child-turn",changes:[]})).output.applied,false);
  await invoke("onTurnEnd",{status:"completed",turnId:"child-turn",response:"done",consumedSteering:0});
  assert.equal(effects.filter(e=>e.method==="doTurn").length,0);
  assert.ok(effects.some(e=>e.method==="endSubagent"));
  assert.equal(state.has("turn"),false);
});
