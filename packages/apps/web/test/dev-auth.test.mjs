import assert from "node:assert/strict";
import {test} from "node:test";
import {UserIdentitySchema} from "@restate-agents/types";
import {developmentIdentity, developmentIdentityLoader} from "../src/server/dev-auth.ts";

test("login bypass is off by default and only literal true enables it", () => {
  for (const flag of [undefined, "false", "1", "TRUE", ""]) {
    assert.equal(developmentIdentity({NODE_ENV: "development", AUTH_DEV_BYPASS: flag}), null);
  }
  assert.equal(developmentIdentity({NODE_ENV: "production"}), null);
});

test("development identity is fixed, isolated from Google, and valid", () => {
  const identity = developmentIdentity({NODE_ENV: "development", AUTH_DEV_BYPASS: "true", USER_ID: "victim", EMAIL: "victim@example.com"});
  assert.deepEqual(identity, {
    userId: "dev-user", issuer: "urn:restate:development", subject: "dev-user",
    displayName: "Development User", email: "developer@example.test",
  });
  assert.deepEqual(UserIdentitySchema.parse(identity), identity);
  identity.userId = "changed";
  assert.equal(developmentIdentity({NODE_ENV: "test", AUTH_DEV_BYPASS: "true"}).userId, "dev-user");
});

test("explicit bypass works in every environment, including next start production mode", () => {
  for (const mode of ["development", "test", "production", undefined, "staging"]) {
    assert.equal(developmentIdentity({NODE_ENV: mode, AUTH_DEV_BYPASS: "true"}).userId, "dev-user");
    assert.equal(developmentIdentity({NODE_ENV: mode}), null);
  }
});

test("registration coalesces, retries failure, and always checks the bypass flag", async t => {
  const oldFlag = process.env.AUTH_DEV_BYPASS, oldMode = process.env.NODE_ENV;
  t.after(() => {
    if (oldFlag === undefined) delete process.env.AUTH_DEV_BYPASS; else process.env.AUTH_DEV_BYPASS = oldFlag;
    if (oldMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldMode;
  });
  process.env.NODE_ENV = "test";
  process.env.AUTH_DEV_BYPASS = "false";
  let calls = 0;
  const load = developmentIdentityLoader(async () => {
    calls++;
    if (calls === 1) throw new Error("Restate unavailable");
  });
  assert.equal(await load(), null);
  assert.equal(calls, 0);
  process.env.AUTH_DEV_BYPASS = "true";
  await assert.rejects(load(), /Restate unavailable/);
  const identities = await Promise.all([load(), load(), load()]);
  assert.equal(calls, 2);
  assert.ok(identities.every(i => i.userId === "dev-user"));
  process.env.NODE_ENV = "production";
  assert.equal((await load()).userId, "dev-user");
  assert.equal(calls, 2);
  process.env.AUTH_DEV_BYPASS = "false";
  assert.equal(await load(), null);
});
