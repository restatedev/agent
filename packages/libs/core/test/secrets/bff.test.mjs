import assert from "node:assert/strict";
import {test} from "node:test";
import {build} from "esbuild";
import {
  openMcpToken,
  openMcpOAuthFlow,
  openMcpOAuthState,
} from "@restate-agents/secrets";

process.env.APP_SECRET_KEY = "test-key-only-32-bytes-not-a-real-secret";
process.env.RESTATE_INGRESS_URL = "http://test-ingress";
globalThis.__authUser={userId:"user-a",sessionId:"session-a"};

// Bundle the real BFF and ingress client. Stub server-only (Next's marker) and
// the external OAuth provider so the entire test stays in-process and offline.
const result = await build({
  stdin: {
    contents:
      'export * from "../../apps/web/src/server/mcp-bearer.ts"; export * from "../../apps/web/src/server/mcp-oauth.ts";',
    resolveDir: process.cwd(),
  },
  platform: "node",
  format: "esm",
  bundle: true,
  write: false,
  plugins: [
    {
      name: "mock-oauth-provider",
      setup(build) {
        build.onResolve({filter:/^\.\/user-auth$/},()=>({path:"user-auth",namespace:"test-auth"}));
        build.onLoad({filter:/.*/,namespace:"test-auth"},()=>({contents:`
          import {userClient,BffError} from "${process.cwd()}/../../apps/web/src/server/restate.ts";
          export function appOrigin(){return "https://app.example";}
          export async function requireUser(){
            const user=globalThis.__authUser;if(!user)throw new BffError(401,"Sign in");
            return {...user,client:userClient(user.userId)};
          }
        `,resolveDir:process.cwd()}));

        build.onResolve(
          {filter: /^(server-only|@modelcontextprotocol\/client)$/},
          (args) => ({path: args.path, namespace: "mock"}),
        );
        build.onLoad({filter: /.*/, namespace: "mock"}, (args) => ({
          contents:
            args.path === "server-only"
              ? ""
              : `
      export const computeScopeUnion = (...scopes) => scopes.filter(Boolean).join(' ');
      export const isStrictScopeSuperset = () => false;
      export async function auth(provider, options) {
        if (options.authorizationCode) {
          if (provider.codeVerifier() !== 'fixture-pkce-secret') throw Error('PKCE was not restored');
          if (provider.clientInformation().client_secret !== 'fixture-client-secret') throw Error('Client was not restored');
          provider.saveTokens({access_token:'fixture-oauth-access',refresh_token:'fixture-refresh',token_type:'Bearer'});
          return 'AUTHORIZED';
        }
        provider.saveCodeVerifier('fixture-pkce-secret');
        provider.saveClientInformation({client_id:'client',client_secret:'fixture-client-secret'});
        const url = new URL('https://oauth.example/authorize');
        url.searchParams.set('state', provider.state());
        provider.redirectToAuthorization(url);
        return 'REDIRECT';
      }
    `,
        }));
      },
    },
  ],
});
const bff = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

test("PAT is encrypted before Restate ingress, with the authenticated User ID", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const req = new Request(url, init);
    if(req.url.endsWith("/ownsAgent"))return Response.json((await req.json()).agentId==="demo");
    if(req.url.endsWith("/mcpAuthorizationContext"))return Response.json((await req.json()).authRequestId==="request"?{
      request:{authRequestId:"request",serverId:"github",authType:"bearer"},
      server:{id:"github",auth:{type:"bearer"}}
    }:null);
    assert.ok(req.url.endsWith("/completeMcpBearerAuthorization"));
    sent.push(await req.json());
    return Response.json(true);
  });
  assert.equal(
    await bff.completeMcpBearerAuthorization( "demo" , {
      authRequestId: "request",
      accessToken: "fixture-pat-secret",
    }),
    true,
  );
  assert.equal(openMcpToken("user-a", sent[0].credential), "fixture-pat-secret");
  assert.ok(!JSON.stringify(sent).includes("fixture-pat-secret"));
  await assert.rejects(() =>
    bff.completeMcpBearerAuthorization("demo", {
      authRequestId: "stale",
      accessToken: "fixture-pat-secret",
    }),
  );
  assert.equal(sent.length, 1);
});

test("OAuth redirect and callback persist only ciphertext and restore PKCE in BFF memory", async (t) => {
  const writes = [];
  const context = {
    request: {
      authRequestId: "request",
      serverId: "notion",
      authType: "oauth",
      reason: "missing_credentials",
    },
    server: {id: "notion", url: "https://mcp.example", auth: {type: "oauth"}},
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const req = new Request(url, init);
    if(req.url.endsWith("/ownsAgent"))return Response.json(true);
    if (req.url.endsWith("/mcpAuthorizationContext"))
      return Response.json(context);
    const body = await req.json();
    writes.push(body);
    if (req.url.endsWith("/saveMcpAuthorizationFlow")) context.flow = body.flow;
    else assert.ok(req.url.endsWith("/completeMcpAuthorization"));
    return Response.json(true);
  });
  const started = await bff.startMcpOAuth(
    new Request("https://app.example/start"),
     "demo" ,
    "request",
  );
  assert.equal(started.status, "redirect");
  const flow = openMcpOAuthFlow("user-a", "notion", "request", context.flow);
  assert.equal(flow.codeVerifier, "fixture-pkce-secret");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  const callback = new Request(
    `https://app.example/api/mcp-oauth/callback?code=fixture-code&state=${encodeURIComponent(state)}`,
  );
  const target = bff.mcpOAuthCallbackTarget(callback);
  assert.deepEqual(target, {userId:"user-a",sessionId:"session-a",agentId: "demo", authRequestId: "request"});
  assert.equal(
    (await bff.finishMcpOAuth(callback, target)).status,
    "completed",
  );
  assert.equal(
    openMcpOAuthState("user-a", writes[1].oauthState).tokens.refresh_token,
    "fixture-refresh",
  );
  assert.equal(
    openMcpToken("user-a", writes[1].oauthState),
    "fixture-oauth-access",
  );
  for (const value of [
    "fixture-pkce-secret",
    "fixture-client-secret",
    "fixture-refresh",
    "fixture-oauth-access",
    "fixture-code",
  ])
    assert.ok(!JSON.stringify(writes).includes(value));
  const bad = new Request(
    "https://app.example/api/mcp-oauth/callback?code=fixture-code&state=wrong",
  );
  await assert.rejects(
    () => bff.finishMcpOAuth(bad, target),
    /state validation failed/,
  );
  assert.equal(writes.length, 2);
  globalThis.__authUser={userId:"user-b",sessionId:"session-b"};
  await assert.rejects(()=>bff.finishMcpOAuth(callback,target),/another login session/);
  globalThis.__authUser={userId:"user-a",sessionId:"different-browser"};
  await assert.rejects(()=>bff.finishMcpOAuth(callback,target),/another login session/);
  globalThis.__authUser={userId:"user-a",sessionId:"session-a"};
});
