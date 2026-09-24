import assert from "node:assert/strict";
import {test} from "node:test";
import {requireSameOrigin, trustedOrigin} from "../src/server/request-guard.ts";

const request = (method, headers) => new Request("http://localhost:3000/api/agent/demo/snapshot", {method, headers});
const rejects = (fn, pattern) => assert.throws(fn, error => error.status === 403 && pattern.test(error.message));

test("reads and writes reject a rebound non-loopback Host", t => {
  const before = process.env.APP_PUBLIC_URL;
  delete process.env.APP_PUBLIC_URL;
  t.after(() => { if (before !== undefined) process.env.APP_PUBLIC_URL = before; });
  rejects(() => trustedOrigin(request("GET", {host: "attacker.example:3000"})), /Untrusted local UI host/);
  rejects(() => requireSameOrigin(request("POST", {host: "attacker.example:3000", origin: "http://attacker.example:3000"})), /Untrusted local UI host/);
  for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"])
    assert.equal(trustedOrigin(request("GET", {host})), `http://${host}`);
});

test("writes require an Origin matching the loopback Host", t => {
  const before = process.env.APP_PUBLIC_URL;
  delete process.env.APP_PUBLIC_URL;
  t.after(() => { if (before !== undefined) process.env.APP_PUBLIC_URL = before; });
  requireSameOrigin(request("POST", {host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000"}));
  rejects(() => requireSameOrigin(request("POST", {host: "127.0.0.1:3000"})), /Cross-origin/);
  rejects(() => requireSameOrigin(request("POST", {host: "127.0.0.1:3000", origin: "http://localhost:3000"})), /Cross-origin/);
  rejects(() => requireSameOrigin(request("POST", {host: "127.0.0.1:3000", origin: "http://evil.example"})), /Cross-origin/);
});

const withEnv = (t, env) => {
  const before = {APP_PUBLIC_URL: process.env.APP_PUBLIC_URL, APP_ALLOWED_HOSTS: process.env.APP_ALLOWED_HOSTS};
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
};

test("APP_PUBLIC_URL defines the trusted origin for proxied deployments", t => {
  withEnv(t, {APP_PUBLIC_URL: "https://agents.example.com", APP_ALLOWED_HOSTS: ""});
  assert.equal(trustedOrigin(request("GET", {host: "agents.example.com"})), "https://agents.example.com");
  assert.equal(trustedOrigin(request("GET", {host: "Agents.Example.com:443"})), "https://agents.example.com");
  requireSameOrigin(request("POST", {host: "agents.example.com", origin: "https://agents.example.com"}));
  rejects(() => requireSameOrigin(request("POST", {host: "agents.example.com", origin: "http://localhost:3000"})), /Cross-origin/);
});

test("APP_PUBLIC_URL still rejects reads through a rebound Host", t => {
  withEnv(t, {APP_PUBLIC_URL: "https://agents.example.com", APP_ALLOWED_HOSTS: ""});
  rejects(() => trustedOrigin(request("GET", {host: "attacker.example"})), /Untrusted UI host/);
  rejects(() => trustedOrigin(request("GET", {host: "internal:3000"})), /Untrusted UI host/);
  rejects(() => trustedOrigin(request("GET", {host: "localhost:3000"})), /Untrusted UI host/);
});

test("APP_ALLOWED_HOSTS admits a proxy's rewritten Host", t => {
  withEnv(t, {APP_PUBLIC_URL: "https://agents.example.com", APP_ALLOWED_HOSTS: "internal:3000, web.svc:3000"});
  assert.equal(trustedOrigin(request("GET", {host: "internal:3000"})), "https://agents.example.com");
  assert.equal(trustedOrigin(request("GET", {host: "web.svc:3000"})), "https://agents.example.com");
  requireSameOrigin(request("POST", {host: "internal:3000", origin: "https://agents.example.com"}));
  rejects(() => trustedOrigin(request("GET", {host: "attacker.example"})), /Untrusted UI host/);
});
