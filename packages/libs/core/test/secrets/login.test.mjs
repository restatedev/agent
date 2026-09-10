import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {build} from "esbuild";
import {openSecret} from "@restate-agents/secrets";

process.env.APP_SECRET_KEY="test-key-only-32-bytes-not-a-real-secret";
process.env.APP_PUBLIC_URL="https://app.example";
process.env.GOOGLE_CLIENT_ID="fixture-client";
process.env.GOOGLE_CLIENT_SECRET="fixture-google-secret";
process.env.GOOGLE_ALLOWED_EMAILS="a@restate.dev";
process.env.RESTATE_INGRESS_URL="http://test-ingress";
const jar=new Map();
const verifiedIdentity={sub:"google-a",email:"a@restate.dev",hd:"restate.dev",email_verified:true,name:"Alice"};
globalThis.__login={jar,verified:{...verifiedIdentity}};
const built=await build({
  stdin:{contents:`export * from "../../apps/web/src/server/user-auth.ts";export {GET as getAuth} from "../../apps/web/app/api/auth/[operation]/route.ts";export {GET as getAgent,POST as postAgent} from "../../apps/web/app/api/agent/[agentId]/[operation]/route.ts";export {POST as postUser} from "../../apps/web/app/api/user/[operation]/route.ts";`,resolveDir:process.cwd()},
  platform:"node",format:"esm",bundle:true,write:false,
  plugins:[{name:"login-fixtures",setup(build){
    build.onResolve({filter:/^(server-only|next\/headers|next\/server|google-auth-library|@modelcontextprotocol\/client)$/},args=>({path:args.path,namespace:"fixture"}));
    build.onLoad({filter:/.*/,namespace:"fixture"},({path})=>({contents:
      path==="server-only"?"":path==="next/headers"?'export async function cookies(){return {get:name=>{const value=globalThis.__login.jar.get(name);return value?{value}:undefined;}};}':
      path==="next/server"?`export const NextResponse={redirect:(url,status=307)=>({url,status,cookies:{set:(name,value,options)=>{globalThis.__login.jar.set(name,value);globalThis.__login.cookieOptions=options;}}})};`:
      path==="@modelcontextprotocol/client"?'export const auth=()=>{};export const computeScopeUnion=()=>{};export const isStrictScopeSuperset=()=>false;':
      `export const CodeChallengeMethod={S256:"S256"};
      export class OAuth2Client {
        async generateCodeVerifierAsync(){return {codeVerifier:"pkce-secret",codeChallenge:"challenge"};}
        generateAuthUrl(options){globalThis.__login.authOptions=options;return "https://accounts.google.com/o/oauth2/v2/auth";}
        async getToken(options){if(globalThis.__login.tokenError)throw globalThis.__login.tokenError;globalThis.__login.exchange=options;return {tokens:{id_token:"signed-token-fixture"}};}
        async verifyIdToken(options){if(globalThis.__login.verifyError)throw globalThis.__login.verifyError;globalThis.__login.verify=options;return {getPayload:()=>globalThis.__login.verified};}
      }`
    }));
  }}],
});
const bff=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const hash=value=>createHash("sha256").update(value).digest("hex");
const sessionKey=token=>hash(JSON.stringify(["google-workspace","restate.dev",token]));

test("Google login binds state, nonce and PKCE; only verified identity and a hashed session reach Restate",async t=>{
  const writes=[];
  t.mock.method(globalThis,"fetch",async(url,init)=>{const request=new Request(url,init);writes.push({url:request.url,body:await request.json()});return Response.json(null);});
  await bff.startGoogleLogin();
  const opts=globalThis.__login.authOptions;
  assert.deepEqual(opts.scope,["openid","email","profile"]);assert.equal(opts.code_challenge_method,"S256");
  assert.equal(opts.hd,"restate.dev");
  const flow=JSON.parse(openSecret(jar.get("restate-login"),["google-login","https://app.example"]));
  assert.equal(flow.codeVerifier,"pkce-secret");assert.ok(!jar.get("restate-login").includes("pkce-secret"));
  await assert.rejects(()=>bff.finishGoogleLogin(new Request("https://app.example/api/auth/callback?state=wrong&code=code")),/invalid or expired/);
  assert.equal(writes.length,0);
  globalThis.__login.verified.nonce=opts.nonce;
  await bff.finishGoogleLogin(new Request(`https://app.example/api/auth/callback?state=${opts.state}&code=code`));
  assert.equal(globalThis.__login.exchange.codeVerifier,"pkce-secret");
  assert.deepEqual(globalThis.__login.verify,{idToken:"signed-token-fixture",audience:"fixture-client"});
  assert.ok(writes[0].url.endsWith("/register"));
  assert.equal(writes[0].body.userId,hash(JSON.stringify(["https://accounts.google.com","google-a"])));
  const rawSession=jar.get("restate-session");
  assert.ok(writes[1].url.includes(`/UserSession/${sessionKey(rawSession)}/create`));
  assert.ok(!JSON.stringify(writes).includes(rawSession));
  for(const secret of ["pkce-secret","signed-token-fixture","fixture-google-secret"])assert.ok(!JSON.stringify(writes).includes(secret));
  assert.equal(globalThis.__login.cookieOptions.httpOnly,true);assert.equal(globalThis.__login.cookieOptions.secure,true);
});

test("all Agent routes authenticate before reading or writing another user's object",async t=>{
  jar.set("restate-session","A".repeat(43));
  const calls=[];
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    const request=new Request(url,init);calls.push(request.url);
    if(request.url.endsWith("/read"))return Response.json({userId:"user-a",expiresAt:Date.now()+10000});
    if(request.url.endsWith("/ownsAgent"))return Response.json(false);
    throw Error("Forbidden Agent RPC was reached");
  });
  for(const operation of ["history","watch","notifications","profile","approvals","mcp-authorizations","schedules","tool-catalog"]){
    const response=await bff.getAgent(new Request(`https://app.example/api/agent/foreign/${operation}`),{params:Promise.resolve({agentId:"foreign",operation})});
    assert.equal(response.status,404,operation);
  }
  for(const operation of ["ask","steer","interrupt","tools","instructions","guardrails","web-search","schedule","cancel-schedule","resolve-approval","start-mcp-authorization","complete-mcp-bearer-authorization"]){
    const response=await bff.postAgent(new Request(`https://app.example/api/agent/foreign/${operation}`,{method:"POST",headers:{origin:"https://app.example"},body:"{}"}),{params:Promise.resolve({agentId:"foreign",operation})});
    assert.equal(response.status,404,operation);
  }
  const count=calls.length;
  assert.equal((await bff.postAgent(new Request("https://app.example/api/agent/foreign/ask",{method:"POST",headers:{origin:"https://attacker.example"},body:"{}"}),{params:Promise.resolve({agentId:"foreign",operation:"ask"})})).status,403);
  assert.equal(calls.length,count);
  jar.clear();assert.equal((await bff.getAgent(new Request("https://app.example/api/agent/foreign/history"),{params:Promise.resolve({agentId:"foreign",operation:"history"})})).status,401);
});

test("Google identity rejects unverified email, nonce mismatch and users outside the allowlist",async()=>{
  for(const override of [{email_verified:false},{nonce:"wrong"},{email:"other@restate.dev"}]){
    jar.clear();await bff.startGoogleLogin();
    const {state,nonce}=globalThis.__login.authOptions;
    globalThis.__login.verified={...verifiedIdentity,nonce,...override};
    await assert.rejects(()=>bff.finishGoogleLogin(new Request(`https://app.example/api/auth/callback?state=${state}&code=code`)),/verification failed|not allowed/);
  }
});

test("Workspace restriction rejects missing, foreign, subdomain and lookalike hd claims before any Restate write",async t=>{
  t.mock.method(globalThis,"fetch",async()=>assert.fail("Rejected identity must not reach Restate"));
  // Keep a matching restate.dev email to prove that an email suffix is insufficient.
  for(const hd of [undefined,"", "gmail.com","other.example","team.restate.dev","restate.dev.attacker.example","notrestate.dev"]){
    jar.clear();await bff.startGoogleLogin();
    const {state,nonce}=globalThis.__login.authOptions;
    globalThis.__login.verified={...verifiedIdentity,nonce,hd};
    await assert.rejects(()=>bff.finishGoogleLogin(new Request(`https://app.example/api/auth/callback?state=${state}&code=code`)),error=>error.status===403&&/restate.dev Google Workspace/.test(error.message));
    assert.equal(jar.has("restate-session"),false);
  }
});

test("an explicitly allowlisted personal account cannot bypass the Workspace restriction",async t=>{
  const previous=process.env.GOOGLE_ALLOWED_EMAILS;
  t.after(()=>{process.env.GOOGLE_ALLOWED_EMAILS=previous;});
  process.env.GOOGLE_ALLOWED_EMAILS="personal@gmail.com";
  t.mock.method(globalThis,"fetch",async()=>assert.fail("Personal account must not reach Restate"));
  jar.clear();await bff.startGoogleLogin();
  const {state,nonce}=globalThis.__login.authOptions;
  globalThis.__login.verified={...verifiedIdentity,nonce,email:"personal@gmail.com",hd:undefined};
  await assert.rejects(()=>bff.finishGoogleLogin(new Request(`https://app.example/api/auth/callback?state=${state}&code=code`)),/restate.dev Google Workspace/);
});

test("verified Workspace accounts can sign in without an email allowlist in development and production",async t=>{
  const previousAllowed=process.env.GOOGLE_ALLOWED_EMAILS,previousMode=process.env.NODE_ENV;
  t.after(()=>{
    process.env.GOOGLE_ALLOWED_EMAILS=previousAllowed;
    if(previousMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousMode;
  });
  delete process.env.GOOGLE_ALLOWED_EMAILS;
  const writes=[];
  t.mock.method(globalThis,"fetch",async(url,init)=>{const request=new Request(url,init);writes.push(request.url);return Response.json(null);});
  for(const mode of ["development","production"]){
    process.env.NODE_ENV=mode;
    jar.clear();await bff.startGoogleLogin();
    const {state,nonce}=globalThis.__login.authOptions;
    globalThis.__login.verified={...verifiedIdentity,nonce};
    await bff.finishGoogleLogin(new Request(`https://app.example/api/auth/callback?state=${state}&code=code`));
    assert.ok(jar.get("restate-session"));
  }
  assert.equal(writes.length,4);
});

test("sessions issued before Workspace enforcement cannot be reused; new sessions can be read and revoked",async t=>{
  jar.clear();
  const oldToken="O".repeat(43),newToken="N".repeat(43);
  const oldKey=hash(oldToken),newKey=sessionKey(newToken),calls=[];
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    const request=new Request(url,init);calls.push(request.url);
    if(request.url.endsWith("/revoke"))return Response.json(null);
    // The legacy session still exists in Restate but must not be looked up.
    return Response.json([oldKey,newKey].some(key=>request.url.includes(`/UserSession/${key}/`))?{userId:"user-a",expiresAt:Date.now()+10000}:null);
  });
  jar.set("restate-session",oldToken);
  assert.equal(await bff.currentUser(),null);
  assert.ok(calls[0].includes(`/UserSession/${sessionKey(oldToken)}/read`));
  jar.set("restate-session",newToken);
  assert.equal((await bff.currentUser()).sessionId,newKey);
  await bff.logout(new Request("https://app.example/api/auth/logout",{method:"POST",headers:{origin:"https://app.example"}}));
  assert.ok(calls.at(-1).endsWith(`/UserSession/${newKey}/revoke`));
  assert.equal(jar.get("restate-session"),"");
});

test("agent creation cannot spoof a User ID or claim an existing Agent ID",async t=>{
  jar.set("restate-session","B".repeat(43));
  const creationId="8ba4cffa-bf07-451a-802f-27f980c2723c",writes=[];
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    const request=new Request(url,init);
    if(request.url.endsWith("/read"))return Response.json({userId:"user-a",expiresAt:Date.now()+10000});
    assert.ok(request.url.includes("/User/user-a/createAgent"));
    const body=await request.json();writes.push(body);return Response.json(body);
  });
  const response=await bff.postUser(new Request("https://app.example/api/user/agent",{method:"POST",headers:{origin:"https://app.example","content-type":"application/json"},body:JSON.stringify({creationId,name:"Research",userId:"user-b",agentId:"foreign-agent"})}),{params:Promise.resolve({operation:"agent"})});
  assert.equal(response.status,200);
  assert.deepEqual(writes,[{agentId:hash(JSON.stringify(["user-a",creationId])),name:"Research"}]);
});

test("callback reports safe token-exchange errors without leaking provider request data",async t=>{
  t.after(()=>{delete globalThis.__login.tokenError;});
  t.mock.method(globalThis,"fetch",async()=>assert.fail("Failed exchange must not reach Restate"));
  for(const [code,status,message] of [
    ["invalid_client",503,/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/],
    ["invalid_grant",400,/do not refresh the callback page/],
    ["redirect_uri_mismatch",503,/callback URL/],
    ["provider-secret-in-error-code",502,/Google token exchange failed/],
  ]){
    jar.clear();await bff.startGoogleLogin();
    const {state}=globalThis.__login.authOptions;
    globalThis.__login.tokenError={message:"secret-in-error-message",response:{data:{error:code,error_description:"secret-in-description"}},config:{data:"client_secret=secret-in-request"}};
    const response=await bff.getAuth(new Request(`https://app.example/api/auth/callback?state=${state}&code=code`),{params:Promise.resolve({operation:"callback"})});
    assert.equal(response.status,status);
    const body=await response.text();assert.match(body,message);
    assert.ok(!body.includes("secret-in-"));assert.equal(jar.has("restate-session"),false);
  }
});

test("callback distinguishes cookie, verification, User and UserSession failures safely",async t=>{
  t.after(()=>{delete globalThis.__login.verifyError;});
  let failedPath="";
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    const request=new Request(url,init);
    return request.url.endsWith(failedPath)?Response.json({message:"secret-in-backend-error"},{status:400}):Response.json(null);
  });
  for(const stage of ["cookie","verification","register","create"]){
    jar.clear();await bff.startGoogleLogin();
    const {state,nonce}=globalThis.__login.authOptions;
    globalThis.__login.verified={...verifiedIdentity,nonce};
    globalThis.__login.verifyError=stage==="verification"?new Error("secret-in-verification-error"):undefined;
    failedPath=`/${stage}`;
    if(stage==="cookie")jar.set("restate-login","invalid-cookie");
    const response=await bff.getAuth(new Request(`https://app.example/api/auth/callback?state=${state}&code=code`),{params:Promise.resolve({operation:"callback"})});
    assert.equal(response.status,stage==="cookie"?400:stage==="verification"?502:503);
    const body=await response.text();
    assert.match(body,{cookie:/login cookie/,verification:/ID-token verification/,register:/saving the user in Restate/,create:/creating the browser session in Restate/}[stage]);
    assert.ok(!body.includes("secret-in-"));assert.equal(jar.has("restate-session"),false);
  }
});
