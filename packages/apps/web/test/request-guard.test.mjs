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

test("APP_PUBLIC_URL defines the trusted origin for proxied deployments", t => {
  const before = process.env.APP_PUBLIC_URL;
  process.env.APP_PUBLIC_URL = "https://agents.example.com";
  t.after(() => { if (before === undefined) delete process.env.APP_PUBLIC_URL; else process.env.APP_PUBLIC_URL = before; });
  assert.equal(trustedOrigin(request("GET", {host: "internal:3000"})), "https://agents.example.com");
  requireSameOrigin(request("POST", {host: "internal:3000", origin: "https://agents.example.com"}));
  rejects(() => requireSameOrigin(request("POST", {origin: "http://localhost:3000"})), /Cross-origin/);
});
