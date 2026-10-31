import assert from "node:assert/strict";
import {test} from "node:test";

import {randomUUID} from "../src/random-uuid.ts";

test("generates v4 UUIDs", (t) => {
  let calls = 0;
  t.mock.getter(globalThis, "crypto", () => ({
    getRandomValues(bytes) {
      assert.ok(bytes instanceof Uint8Array);
      assert.equal(bytes.length, 16);
      calls++;
      return bytes.fill(calls === 1 ? 0 : 255);
    },
  }));

  assert.equal(randomUUID(), "00000000-0000-4000-8000-000000000000");
  assert.equal(randomUUID(), "ffffffff-ffff-4fff-bfff-ffffffffffff");
  assert.equal(calls, 2);
});
