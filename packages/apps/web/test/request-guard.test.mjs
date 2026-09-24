import assert from "node:assert/strict";
import {test} from "node:test";

import {requireSameOrigin, trustedOrigin} from "../src/server/request-guard.ts";

const PUBLIC_URL = "https://agents.example.com";

/** A proxy request as Next.js hands it to the route: request.url says localhost. */
function request(method, headers) {
  return new Request("http://localhost:3000/api/agent/demo/snapshot", {
    method,
    headers,
  });
}

function read(host) {
  return request("GET", {host});
}

function write(host, origin) {
  const headers = {origin};
  if (host) {
    headers.host = host;
  }
  return request("POST", headers);
}

/** Asserts a 403 whose message matches `pattern`. */
function assertForbidden(check, pattern) {
  assert.throws(check, (error) => {
    return error.status === 403 && pattern.test(error.message);
  });
}

/** Sets the guard's environment for one test and restores it afterwards. */
function useEnv(t, env) {
  const saved = {};
  for (const key of ["APP_PUBLIC_URL", "APP_ALLOWED_HOSTS"]) {
    saved[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test("locally, reads and writes reject a rebound non-loopback Host", (t) => {
  useEnv(t, {});

  assertForbidden(
    () => trustedOrigin(read("attacker.example:3000")),
    /Untrusted local UI host/,
  );
  assertForbidden(
    () =>
      requireSameOrigin(
        write("attacker.example:3000", "http://attacker.example:3000"),
      ),
    /Untrusted local UI host/,
  );
});

test("locally, every loopback Host is its own trusted origin", (t) => {
  useEnv(t, {});

  for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
    assert.equal(trustedOrigin(read(host)), `http://${host}`);
  }
});

test("locally, writes require an Origin matching the loopback Host", (t) => {
  useEnv(t, {});
  const host = "127.0.0.1:3000";

  requireSameOrigin(write(host, "http://127.0.0.1:3000"));

  assertForbidden(() => requireSameOrigin(write(host)), /Cross-origin/);
  assertForbidden(
    () => requireSameOrigin(write(host, "http://localhost:3000")),
    /Cross-origin/,
  );
  assertForbidden(
    () => requireSameOrigin(write(host, "http://evil.example")),
    /Cross-origin/,
  );
});

test("behind a proxy, APP_PUBLIC_URL is the trusted origin", (t) => {
  useEnv(t, {APP_PUBLIC_URL: PUBLIC_URL});

  assert.equal(trustedOrigin(read("agents.example.com")), PUBLIC_URL);
  // Host is case-insensitive and may spell out the default port.
  assert.equal(trustedOrigin(read("Agents.Example.com:443")), PUBLIC_URL);

  requireSameOrigin(write("agents.example.com", PUBLIC_URL));
  assertForbidden(
    () =>
      requireSameOrigin(write("agents.example.com", "http://localhost:3000")),
    /Cross-origin/,
  );
});

test("behind a proxy, reads through a rebound Host are rejected", (t) => {
  useEnv(t, {APP_PUBLIC_URL: PUBLIC_URL});

  for (const host of ["attacker.example", "internal:3000", "localhost:3000"]) {
    assertForbidden(() => trustedOrigin(read(host)), /Untrusted UI host/);
  }
});

test("APP_ALLOWED_HOSTS admits the Host a rewriting proxy sends", (t) => {
  useEnv(t, {
    APP_PUBLIC_URL: PUBLIC_URL,
    APP_ALLOWED_HOSTS: "internal:3000, web.svc:3000",
  });

  assert.equal(trustedOrigin(read("internal:3000")), PUBLIC_URL);
  assert.equal(trustedOrigin(read("web.svc:3000")), PUBLIC_URL);
  requireSameOrigin(write("internal:3000", PUBLIC_URL));

  assertForbidden(
    () => trustedOrigin(read("attacker.example")),
    /Untrusted UI host/,
  );
});
