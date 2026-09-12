import assert from "node:assert/strict";
import {test} from "node:test";
import {User,UserSession} from "../../src/user/service.ts";
import {Agent} from "../../src/agent/service.ts";
import {toolAllowed} from "../../src/session/tool-permissions.ts";
import {sealMcpToken,sealMcpOAuthFlow,sealMcpOAuthState} from "@restate-agents/secrets";
import {objectFixture} from "./fixture.mjs";

process.env.APP_SECRET_KEY="test-key-only-32-bytes-not-a-real-secret";
const permissions={builtin:{mode:"all"},dynamic:{mode:"selected",names:[]},mcp:[{connectionId:"notion",tools:{mode:"all"}}]};
const server={id:"notion",type:"http",url:"https://mcp.example.test",protocol:"stateful",auth:{type:"oauth"}};
const identity={userId:"user-a",issuer:"https://accounts.google.com",subject:"google-sub",email:"a@example.test",displayName:"A"};
const request=(id,turnId="turn-1")=>({authRequestId:id,serverId:"notion",turnId,authType:"oauth",reason:"missing_credentials",connectionRevision:1});
async function setup() {
  const fixture=objectFixture(User,{state:new Map([["identity",identity],["agents",[{agentId:"agent-a",name:"A"},{agentId:"agent-b",name:"B"}]]])});
  assert.equal((await fixture.invoke("upsertConnection",server)).output.value.accepted,true);
  return fixture;
}

test("User creates a stable directory; Agent ownership cannot be reassigned",async()=>{
  const user=objectFixture(User,{state:new Map([["identity",identity]])});
  const agent={agentId:"agent-a",name:"Research"};
  assert.deepEqual((await user.invoke("createAgent",agent)).output.value,agent);
  assert.deepEqual((await user.invoke("createAgent",agent)).output.value,agent);
  assert.equal(user.effects.filter(e=>e.method==="initialize").length,1);
  assert.deepEqual(user.effects.find(e=>e.method==="initialize").parameter,{ownerUserId:"user-a",name:"Research"});
  const own=objectFixture(Agent,{key:"agent-a"});
  assert.equal((await own.invoke("initialize",{ownerUserId:"user-a",name:"A"})).output.value,null);
  assert.match((await own.invoke("initialize",{ownerUserId:"user-b",name:"B"})).output.error,/immutable/);
  assert.equal((await own.invoke("ownership")).output.value.ownerUserId,"user-a");
});

test("two agents share one encrypted OAuth flow; cancelling one keeps the other waiter",async()=>{
  const f=await setup();
  await f.invoke("requestMcpAuthorization",{agentId:"agent-a",request:request("first")});
  const second=(await f.invoke("requestMcpAuthorization",{agentId:"agent-b",request:request("second","turn-2")})).output.value;
  assert.equal(second.flowId,"first");
  assert.equal(f.state.get("authorizations").length,1);
  const flow=sealMcpOAuthFlow("user-a","notion","first",{redirectUrl:"https://app.test/callback",state:"private-state",codeVerifier:"private-verifier"});
  assert.equal((await f.invoke("saveMcpAuthorizationFlow",{authRequestId:"second",flow,expectedFlow:null})).output.value,true);
  await f.invoke("cancelMcpAuthorization",{agentId:"agent-a",authRequestId:"first",turnId:"turn-1"});
  assert.equal((await f.invoke("mcpAuthorizationContext",{authRequestId:"second"})).output.value.flow,flow);
  const oauthState=sealMcpOAuthState("user-a",{serverId:"notion",tokens:{access_token:"private-access",refresh_token:"private-refresh",token_type:"Bearer"}});
  const input={authRequestId:"second",oauthState,expectedFlow:flow};
  const before=structuredClone(f.state),complete=await f.invoke("completeMcpAuthorization",input);
  assert.equal(complete.output.value,true);
  const after=structuredClone(f.state);
  const deliveries=f.effects.filter(e=>e.method==="resolveMcpAuthorization");
  assert.equal(deliveries.length,1);assert.equal(deliveries[0].key,"agent-b");
  assert.deepEqual(Object.keys(deliveries[0].parameter.resolution.credential).sort(),["encryptedToken","serverId"]);
  f.state.clear();for(const [k,v] of before)f.state.set(k,v);
  assert.equal((await f.invoke("completeMcpAuthorization",input,complete.journal)).output.value,true);
  assert.deepEqual(f.state,after);
  const snapshot=(await f.invoke("snapshot",{agentId:"agent-a",tools:permissions})).output.value;
  assert.equal(snapshot.credentials[0].encryptedToken,oauthState.encryptedToken);
  const publicProfile=(await f.invoke("profile")).output.value;
  assert.ok(!JSON.stringify(publicProfile).includes(oauthState.encryptedToken));
  const durable=JSON.stringify({state:[...f.state],effects:f.effects})+Buffer.concat(complete.journal).toString();
  for(const secret of ["private-access","private-refresh","private-state","private-verifier"])assert.ok(!durable.includes(secret));
});

test("OAuth compare-and-set rejects concurrent starts and superseded completions",async()=>{
  const f=await setup();await f.invoke("beginAuthorization",{connectionId:"notion",authRequestId:"manual"});
  const flow=id=>sealMcpOAuthFlow("user-a","notion","manual",{redirectUrl:"https://app.test/cb",state:id,codeVerifier:"verifier"});
  const a=flow("a"),b=flow("b");
  assert.equal((await f.invoke("saveMcpAuthorizationFlow",{authRequestId:"manual",flow:a,expectedFlow:null})).output.value,true);
  assert.equal((await f.invoke("saveMcpAuthorizationFlow",{authRequestId:"manual",flow:b,expectedFlow:null})).output.value,false);
  assert.equal((await f.invoke("saveMcpAuthorizationFlow",{authRequestId:"manual",flow:b,expectedFlow:a})).output.value,true);
  const oauthState=sealMcpOAuthState("user-a",{serverId:"notion",tokens:{access_token:"obsolete-token",token_type:"Bearer"}});
  assert.equal((await f.invoke("completeMcpAuthorization",{authRequestId:"manual",oauthState,expectedFlow:a})).output.value,false);
  assert.equal(f.state.get("connections")[0].credential,undefined);
});

test("cross-user agent access, removed generations and unauthorized connections fail closed",async()=>{
  const f=await setup();
  assert.match((await f.invoke("snapshot",{agentId:"foreign-agent",tools:permissions})).output.error,/does not belong/);
  assert.deepEqual((await f.invoke("snapshot",{agentId:"agent-a",tools:{...permissions,mcp:[]}})).output.value,{tools:{...permissions,mcp:[]},memories:[],servers:[],credentials:[]});
  await f.invoke("requestMcpAuthorization",{agentId:"agent-a",request:request("first")});
  await f.invoke("removeConnection",{id:"notion"});
  await f.invoke("upsertConnection",server);
  assert.equal((await f.invoke("validateConnection",{agentId:"agent-a",connectionId:"notion",revision:1})).output.value,false);
  assert.equal((await f.invoke("requestMcpAuthorization",{agentId:"agent-a",request:request("stale")})).output.value,null);
  assert.equal(f.effects.find(e=>e.method==="resolveMcpAuthorization").parameter.resolution.status,"cancelled");
});

test("fresh shared tokens wake stale turns without launching another authorization",async()=>{
  const f=await setup(),credential=sealMcpToken("user-a","notion","new-token");
  f.state.get("connections")[0].credential=credential;
  await f.invoke("requestMcpAuthorization",{agentId:"agent-a",request:{...request("first"),rejectedToken:sealMcpToken("user-a","notion","old-token").encryptedToken}});
  assert.equal(f.state.get("authorizations").length,0);
  assert.equal(f.effects.find(e=>e.method==="resolveMcpAuthorization").parameter.resolution.credential.encryptedToken,credential.encryptedToken);
});

test("turn snapshots retain grants; interruption removes only that Agent's waiter and rejects late completion",async()=>{
  const pending=request("request"),state=new Map([["ownership",{ownerUserId:"user-a",name:"A"}],["turn",{id:"turn-1",tools:permissions,steeringBatches:[]}],["profile/tools",{...permissions,mcp:[]}]]);
  const f=objectFixture(Agent,{key:"agent-a",state,rpc:opts=>opts.method==="requestMcpAuthorization"?pending:null});
  assert.equal((await f.invoke("requestMcpAuthorization",pending)).output.value.authRequestId,"request");
  assert.equal((await f.invoke("interrupt",{reason:"Stop"})).output.value,true);
  assert.deepEqual(state.get("mcp/authorization-requests"),[]);
  assert.equal(f.effects.find(e=>e.method==="cancelMcpAuthorization").key,"user-a");
  assert.equal(f.effects.find(e=>e.signal?.startsWith("mcp-authorization")).value.status,"cancelled");
  const count=f.effects.filter(e=>e.signal).length;
  await f.invoke("resolveMcpAuthorization",{authRequestId:"request",turnId:"turn-1",resolution:{status:"authorized",credential:sealMcpToken("user-a","notion","late-token")}});
  assert.equal(f.effects.filter(e=>e.signal).length,count);
});

test("next turn receives the owner's ciphertext and immutable grant snapshot",async()=>{
  const credential=sealMcpToken("user-a","notion","turn-token");
  const f=objectFixture(Agent,{key:"agent-a",state:new Map([["ownership",{ownerUserId:"user-a",name:"A"}],["profile/tools",permissions]]),rpc:opts=>{
    assert.equal(opts.service,"User");assert.equal(opts.key,"user-a");assert.equal(opts.method,"snapshot");
    return {tools:permissions,memories:[],servers:[{...server,revision:1}],credentials:[credential]};
  }});
  assert.equal((await f.invoke("ask",{message:"Hello"})).output.value.decision,"start");
  const request=f.effects.find(e=>e.method==="doTurn").parameter;
  assert.equal(request.ownerUserId,"user-a");assert.deepEqual(request.tools,permissions);assert.deepEqual(request.mcpCredentials,[credential]);
  assert.ok(!JSON.stringify(request).includes("turn-token"));
});

test("permissions bind dynamic service/handler and raw MCP tool names",()=>{
  const dynamic=[{name:"friendlyAlias",target:{service:"Catalog",handler:"lookup"}}];
  const mcp=[{name:"mcp__notion__read",target:{server:{id:"notion"},remoteName:"read"}},{name:"mcp__notion__write",target:{server:{id:"notion"},remoteName:"write"}}];
  const grants={builtin:{mode:"selected",names:["getWeather","runProgram"]},dynamic:{mode:"selected",names:["Catalog/lookup"]},mcp:[{connectionId:"notion",tools:{mode:"selected",names:["read"]}}]};
  const allowed=name=>toolAllowed(name,grants,dynamic,mcp,["getWeather","executeCommand","runProgram"]);
  assert.equal(allowed("getWeather"),true);assert.equal(allowed("executeCommand"),false);
  assert.equal(allowed("friendlyAlias"),true);assert.equal(allowed("mcp__notion__read"),true);assert.equal(allowed("mcp__notion__write"),false);
  assert.equal(allowed("unknown"),false);
});

test("browser sessions expire and revoke independently from user credentials",async()=>{
  const f=objectFixture(UserSession,{now:1000});
  await f.invoke("create",{userId:"user-a",expiresAt:2000});
  assert.equal((await f.invoke("read")).output.value.userId,"user-a");
  assert.match((await f.invoke("create",{userId:"user-b",expiresAt:3000})).output.error,/already exists/);
  await f.invoke("revoke");assert.equal((await f.invoke("read")).output.value,null);
  await f.invoke("create",{userId:"user-a",expiresAt:999});assert.equal((await f.invoke("read")).output.value,null);
});

test("PAT completion persists ciphertext once and rejects a different connection",async()=>{
  const f=await setup();
  await f.invoke("upsertConnection",{...server,auth:{type:"bearer"}});
  await f.invoke("beginAuthorization",{connectionId:"notion",authRequestId:"pat"});
  assert.equal((await f.invoke("completeMcpBearerAuthorization",{authRequestId:"pat",credential:sealMcpToken("user-a","other","wrong")})).output.value,false);
  const credential=sealMcpToken("user-a","notion","pat-secret");
  assert.equal((await f.invoke("completeMcpBearerAuthorization",{authRequestId:"pat",credential})).output.value,true);
  assert.deepEqual(f.state.get("connections")[0].credential,credential);
  assert.ok(!JSON.stringify([...f.state]).includes("pat-secret"));
  assert.equal((await f.invoke("completeMcpBearerAuthorization",{authRequestId:"pat",credential})).output.value,false);
});

test("retrying an expired authorization preserves all attached agents",async()=>{
  const f=await setup();
  await f.invoke("requestMcpAuthorization",{agentId:"agent-a",request:request("first")});
  await f.invoke("requestMcpAuthorization",{agentId:"agent-b",request:request("second","turn-2")});
  f.state.get("authorizations")[0].expiresAt=0;
  assert.equal((await f.invoke("mcpAuthorizationContext",{authRequestId:"first"})).output.value,null);
  await f.invoke("beginAuthorization",{connectionId:"notion",authRequestId:"retry"});
  assert.equal(f.state.get("authorizations")[0].waiters.length,2);
  assert.ok((await f.invoke("mcpAuthorizationContext",{authRequestId:"second"})).output.value);
});
