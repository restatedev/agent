import assert from "node:assert/strict";
import {test} from "node:test";
import {build} from "esbuild";
import {AgentToolsSchema} from "@restate-agents/types";
import {connectionEnabled, toggleConnection, toggleTool, toolEnabled} from "../../../../apps/web/src/tool-toggles.ts";
import {toolAllowed} from "../../src/session/tool-permissions.ts";

const defaults=()=>({builtin:{mode:"all"},dynamic:{mode:"selected",names:[]},mcp:[]});
test("authorized connections default on and off persists an explicit opt-out",()=>{
  const original=defaults();
  assert.equal(connectionEnabled(original,"notion"),true);
  const github=toggleConnection(original,"github",true);
  const enabled=toggleConnection(github,"notion",true);
  AgentToolsSchema.parse(enabled);
  assert.deepEqual(enabled.mcp.find(g=>g.connectionId==="notion"),{connectionId:"notion",tools:{mode:"all"}});
  assert.equal(connectionEnabled(enabled,"notion"),true);
  const remote=[{name:"mcp_notion_search",target:{server:{id:"notion"},remoteName:"search"}}];
  assert.equal(toolAllowed("mcp_notion_search",enabled,[],remote,[]),true);
  const disabled=toggleConnection(enabled,"notion",false);
  assert.equal(toolAllowed("mcp_notion_search",disabled,[],remote,[]),false);
  assert.deepEqual(disabled,{...github,mcp:[...github.mcp,{connectionId:"notion",tools:{mode:"selected",names:[]}}]});
  assert.equal(connectionEnabled(disabled,"notion"),false);
  assert.deepEqual(original,defaults(),"other agents' profiles must not be mutated");
  assert.deepEqual(toggleConnection(enabled,"notion",true),enabled,"enabling twice must not duplicate a grant");
});
test("an empty saved selection is off, and enabling it cannot retain the zero-tool trap",()=>{
  const empty={...defaults(),mcp:[{connectionId:"notion",tools:{mode:"selected",names:[]}}]};
  assert.equal(connectionEnabled(empty,"notion"),false);
  assert.deepEqual(toggleConnection(empty,"notion",true).mcp,[{connectionId:"notion",tools:{mode:"all"}}]);
});
test("individual tool toggles preserve unrelated grants and unavailable selected names",()=>{
  const selection=toggleTool({mode:"all"},["getWeather","sleep"],"sleep",false);
  assert.equal(toolEnabled(selection,"getWeather"),true);
  assert.equal(toolEnabled(selection,"sleep"),false);
  const retained=toggleTool({mode:"selected",names:["temporarilyMissing"]},["getWeather"],"getWeather",true);
  assert.deepEqual(retained,{mode:"selected",names:["temporarilyMissing","getWeather"]});
  assert.deepEqual(toggleTool(retained,[],"getWeather",false),{mode:"selected",names:["temporarilyMissing"]});
});
test("agent UI renders name-only connection switches with account-level authorization",async()=>{
  const built=await build({
    stdin:{resolveDir:process.cwd(),contents:`import React from '../../apps/web/node_modules/react/index.js'; import {renderToStaticMarkup} from '../../apps/web/node_modules/react-dom/server.node.js'; import {AgentToolsPanel} from '../../apps/web/src/agent-tools-panel.tsx'; import {UserContext} from '../../apps/web/src/user-context.tsx'; export function render(profile,user){return renderToStaticMarkup(React.createElement(UserContext.Provider,{value:{profile:user,refresh:async()=>{}}},React.createElement(AgentToolsPanel,{client:{},profile,refresh:async()=>profile,notify:()=>{}})));}`},
    platform:"node",format:"esm",bundle:true,write:false,jsx:"automatic",
    define:{"process.env.NODE_ENV":'"production"'},
    banner:{js:`import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(import.meta.url)});`},
  });
  const {render}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`).catch(error=>{throw new Error(error.message);});
  const connection=(id,connected)=>({server:{id,type:"http",url:"https://example.test/mcp",protocol:"stateful",auth:{type:"oauth"}},connected,tools:[{name:"search",description:"VERY LONG DESCRIPTION MUST NOT APPEAR"}]});
  const html=render({tools:defaults()},{connections:[connection("notion",true),connection("github",false)]});
  assert.match(html,/Notion/);
  assert.equal((html.match(/role="switch"/g)||[]).length,2);
  assert.equal((html.match(/class="web-search-toggle"/g)||[]).length,2);
  assert.equal((html.match(/class="web-search-toggle-track"/g)||[]).length,2);
  assert.ok(!html.includes('type="checkbox"'));
  assert.match(html,/aria-checked="false"/);
  assert.match(html,/>Disabled<\/button>/);
  assert.match(html,/Authorize GitHub in Profile &amp; connectors/);
  assert.match(html,/disabled=""/);
  for(const text of ["<select","Load available tools","Selected tools only","VERY LONG DESCRIPTION MUST NOT APPEAR"])assert.ok(!html.includes(text),text);
  const on=render({tools:toggleConnection(defaults(),"notion",true)},{connections:[connection("notion",true)]});
  assert.match(on,/aria-checked="true"/);
  assert.match(on,/>Enabled<\/button>/);
});
