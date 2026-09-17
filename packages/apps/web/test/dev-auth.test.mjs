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

test("production and unspecified environments refuse enabled bypass", () => {
  for (const mode of ["production", undefined, "staging"]) {
    assert.throws(() => developmentIdentity({NODE_ENV: mode, AUTH_DEV_BYPASS: "true"}), /only allowed in development or test/);
  }
});

test("registration coalesces, retries failure, and never skips the environment check", async t => {
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
  await assert.rejects(load(), /only allowed in development or test/);
  process.env.AUTH_DEV_BYPASS = "false";
  assert.equal(await load(), null);
});
