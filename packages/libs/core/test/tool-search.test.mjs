import assert from "node:assert/strict";
import {test} from "node:test";

import * as durable from "@restatedev/restate-sdk-gen";
import MiniSearch from "minisearch";

import {executeCall} from "../src/session/step.ts";
import {createToolSearch} from "../src/session/tool-search.ts";
import * as tools from "../src/session/tools.ts";
import {runHandler} from "./harness.mjs";

const schema = {
  type: "object",
  properties: {unreadOnly: {type: "boolean"}},
  required: ["unreadOnly"],
};
const dynamic = [
  {
    name: "findBuild",
    description: "Find a build by commit",
    inputSchema: schema,
    target: {
      service: "Builds",
      handler: "find",
      keyed: false,
      acceptsInput: true,
    },
  },
];
const mcp = ["listNotifications", "listRepositories", "forbiddenSecrets"].map(
  (name) => ({
    name: `github_${name}`,
    description:
      name === "listNotifications" ? "Read unread notifications" : name,
    inputSchema: schema,
    target: {server: {id: "github"}, remoteName: name},
  }),
);
const permissions = {
  builtin: {mode: "all"},
  dynamic: {mode: "all"},
  mcp: [
    {
      serverId: "github",
      tools: {
        mode: "selected",
        names: ["listNotifications", "listRepositories"],
      },
    },
  ],
};
const context = () =>
  tools.createAgentToolContext("agent", "turn", false, permissions, "alice");
const names = (catalog) => catalog.map((t) => t.name);
const call = {
  toolName: "searchTools",
  toolCallId: "search-1",
  input: {query: "github unread notifications"},
};

test("full-text ranking splits identifiers, boosts exact names, and bounds results", () => {
  const catalog = Array.from({length: 12}, (_, i) => ({
    name: `lookup_${i}`,
    description: "Find issues",
    inputSchema: schema,
  }));
  catalog.push({
    name: "listNotifications",
    description: "Read unread notifications",
    inputSchema: schema,
  });
  const search = createToolSearch(
    catalog,
    new Map([["listNotifications", "github"]]),
  );
  assert.equal(
    search.search("github unread notifications")[0],
    "listNotifications",
  );
  assert.equal(search.search("list_notifications")[0], "listNotifications");
  assert.equal(search.search("lookup_9")[0], "lookup_9");
  assert.equal(search.search("issues").length, 5);
  assert.ok(search.search("unreadOnly").length > 0);
  assert.deepEqual(search.search("zzzzunmatchedzzzz"), []);
});

test("search loads only permitted schemas and restores selections without reranking on replay", async (t) => {
  const attempt = (replay) =>
    runHandler(
      (ctx) =>
        durable.execute(
          ctx,
          durable.gen(function* () {
            const state = context();
            const before = names(tools.modelManifests(dynamic, mcp, state));
            const outcome = yield* tools.execute(call, state, dynamic, mcp);
            const after = names(tools.modelManifests(dynamic, mcp, state));
            const forbidden = yield* tools.execute(
              {
                ...call,
                toolCallId: "forbidden",
                input: {query: "forbiddenSecrets"},
              },
              state,
              dynamic,
              mcp,
            );
            return {before, after, outcome, forbidden};
          }),
        ),
      {replay},
    );
  const first = await attempt([]);
  assert.ok(first.output.before.includes("searchTools"));
  assert.ok(!first.output.before.includes("github_listNotifications"));
  assert.ok(!first.output.before.includes("findBuild"));
  assert.ok(first.output.after.includes("github_listNotifications"));
  assert.ok(!first.output.after.includes("github_forbiddenSecrets"));
  assert.ok(
    !JSON.parse(first.output.forbidden.result).matches.some(
      (m) => m.name === "github_forbiddenSecrets",
    ),
  );
  assert.ok(
    !Object.hasOwn(
      JSON.parse(first.output.outcome.result).matches[0],
      "inputSchema",
    ),
  );
  t.mock.method(MiniSearch.prototype, "search", () => {
    throw Error("Replay must not rerank");
  });
  const replayed = await attempt(first.journal);
  assert.deepEqual(replayed.output, first.output);
  assert.ok(
    !names(tools.modelManifests(dynamic, mcp, context())).includes(
      "github_listNotifications",
    ),
    "a fresh turn forgets loaded schemas",
  );
  const other = context();
  other.permissions = {
    ...permissions,
    dynamic: {mode: "selected", names: []},
    mcp: [],
  };
  assert.ok(
    !names(tools.manifests(dynamic, mcp, other)).includes(
      "github_listNotifications",
    ),
  );
});

test("PTC retains runtime access to permitted tools whose schemas are deferred", async () => {
  const result = await runHandler((ctx) =>
    durable.execute(
      ctx,
      durable.gen(function* () {
        const state = context();
        tools.modelManifests(dynamic, mcp, state);
        return yield* executeCall(
          {
            toolName: "executeProgram",
            toolCallId: "program",
            input: {
              source:
                "async tools => ({github: typeof tools.github_listNotifications, dynamic: typeof tools.findBuild, forbidden: typeof tools.github_forbiddenSecrets})",
            },
          },
          state,
          dynamic,
          mcp,
          {
            transcript: {*append() {}},
            step: 1,
            *guard() {},
            *cancelPending() {
              throw Error("unused");
            },
          },
        );
      }),
    ),
  );
  assert.equal(result.output.status, "succeeded");
  assert.deepEqual(JSON.parse(result.output.result), {
    github: "function",
    dynamic: "function",
    forbidden: "undefined",
  });
});

test("disabled tool search leaves an eager catalog; invalid queries do not load tools", async () => {
  const state = context();
  state.permissions = {
    ...permissions,
    builtin: {mode: "selected", names: ["getWeather"]},
  };
  assert.ok(
    names(tools.modelManifests(dynamic, mcp, state)).includes("findBuild"),
  );
  const result = await runHandler((ctx) =>
    durable.execute(
      ctx,
      tools.execute({...call, input: {query: "  "}}, context(), dynamic, mcp),
    ),
  );
  assert.equal(result.output.status, "failed");
});
