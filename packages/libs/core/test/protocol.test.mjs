import assert from "node:assert/strict";
import test from "node:test";

import {
  createEndpointHandler,
  service,
  TerminalError,
} from "@restatedev/restate-sdk/fetch";

import {executeWithTools as executeProgram} from "./adapter.ts";

// In-memory service-protocol peer. Real SDK/core/guest, simulated server journal.
const cat = (...xs) => Buffer.concat(xs.map((x) => Buffer.from(x)));
function vi(n) {
  const a = [];
  do {
    const b = n % 128;
    n = Math.floor(n / 128);
    a.push(b | (n ? 128 : 0));
  } while (n);
  return Buffer.from(a);
}
function field(n, v) {
  if (typeof v === "number") return cat(vi(n * 8), vi(v));
  const b = Buffer.from(v);
  return cat(vi(n * 8 + 2), vi(b.length), b);
}
function pb(...entries) {
  return cat(...entries.map(([n, v]) => field(n, v)));
}
function decode(b) {
  let at = 0;
  const m = new Map();
  const v = () => {
    let n = 0,
      s = 1,
      c;
    do {
      c = b[at++];
      n += (c & 127) * s;
      s *= 128;
    } while (c & 128);
    return n;
  };
  while (at < b.length) {
    const tag = v(),
      n = Math.floor(tag / 8),
      t = tag % 8;
    if (t === 0) m.set(n, v());
    else if (t === 2) {
      const len = v();
      m.set(n, b.subarray(at, at + len));
      at += len;
    } else throw Error("wire " + t);
  }
  return m;
}
function frame(type, body) {
  const h = Buffer.alloc(8);
  h.writeUInt16BE(type);
  h.writeUInt32BE(body.length, 4);
  return cat(h, body);
}
const input = frame(0x400, pb([14, pb([1, "{}"])]));
const source = `async tools => {
  const a=tools.lookup('a'); const b=tools.lookup('b');
  const winner=await Promise.race([a,b]);
  await tools.record(winner);
  const all=await Promise.all([a,b]);
  return {winner,all};
}`;

async function attempt(replay = [], program = source, failB = false) {
  let controller,
    releaseA,
    bSeen = false;
  const journal = [...(replay.length ? replay : [input])],
    effects = [],
    issued = [];
  const tools = {
    lookup: async (key) => {
      effects.push(["lookup", key]);
      if (key === "a" && !bSeen) await new Promise((r) => (releaseA = r));
      if (key === "b" && failB) throw new TerminalError("b failed");
      return key;
    },
    record: async (winner) => {
      effects.push(["record", winner]);
      return null;
    },
  };
  // In a partial replay containing b's completion, unfinished a may run now.
  const isB = (outcome) =>
    outcome.value === "b" || outcome.error?.message === "b failed";
  bSeen = replay.some(
    (f) =>
      f.readUInt16BE(0) === 0x8011 &&
      isB(
        JSON.parse(
          decode(decode(f.subarray(8)).get(5))
            .get(1)
            .toString(),
        ),
      ),
  );
  const handler = createEndpointHandler({
    bidirectional: true,
    services: [
      service({
        name: "Review",
        handlers: {
          run: (ctx) =>
            executeProgram(
              new Proxy(ctx, {
                get(target, key) {
                  const value = Reflect.get(target, key);
                  if (key === "run")
                    return (...args) => {
                      issued.push(args[0]);
                      return value.apply(target, args);
                    };
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                },
              }),
              program,
              tools,
            ),
        },
      }),
    ],
  });
  const start = frame(
    0,
    pb(
      [1, Buffer.alloc(16, 1)],
      [2, "review-invocation"],
      [3, journal.length],
      [9, 42],
    ),
  );
  const body = new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(cat(start, ...journal));
    },
  });
  const response = await handler(
    new Request("http://local/invoke/Review/run", {
      method: "POST",
      headers: {"content-type": "application/vnd.restate.invocation.v7"},
      body,
      duplex: "half",
    }),
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let buffer = Buffer.alloc(0),
    output;
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    buffer = cat(buffer, value);
    while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt32BE(4)) {
      const size = 8 + buffer.readUInt32BE(4),
        f = buffer.subarray(0, size);
      buffer = buffer.subarray(size);
      const type = f.readUInt16BE(0),
        data = decode(f.subarray(8));
      if (type === 0x411) {
        journal.push(Buffer.from(f));
      } else if (type === 5) {
        const id = data.get(1) ?? 0;
        assert.ok(data.has(14), "tool proposal should succeed");
        const completion = frame(
          0x8011,
          pb([1, id], [5, pb([1, data.get(14)])]),
        );
        journal.push(completion);
        controller.enqueue(frame(7, pb([1, id])));
        const outcome = JSON.parse(data.get(14).toString());
        if (isB(outcome)) {
          bSeen = true;
          releaseA?.();
        }
      } else if (type === 0x401) {
        assert.ok(data.has(14), "handler should succeed");
        output = JSON.parse(decode(data.get(14)).get(1).toString());
        controller.close();
      } else if (type === 2) {
        throw Error(
          "SDK error: " +
            [...data].map(([k, v]) => [
              k,
              Buffer.isBuffer(v) ? v.toString() : v,
            ]),
        );
      }
    }
  }
  try {
    controller.close();
  } catch {}
  assert.ok(output);
  return {journal, effects, issued, output};
}

test(
  "real SDK protocol: race completion order survives full and partial journal replay",
  {
    timeout: 8000,
  },
  async () => {
    const live = await attempt();
    assert.equal(live.output.winner, "b");
    const replay = await attempt(live.journal);
    assert.deepEqual(replay.output, live.output);
    assert.deepEqual(replay.issued, live.issued);
    assert.deepEqual(replay.effects, []);
    const cut = live.journal.findIndex((f) => f.readUInt16BE(0) === 0x8011);
    const partial = await attempt(live.journal.slice(0, cut + 1));
    assert.deepEqual(partial.output, live.output);
    assert.deepEqual(partial.issued, live.issued);
    assert.ok(
      partial.effects.some(([name, key]) => name === "lookup" && key === "a"),
    );
    assert.ok(
      !partial.effects.some(([name, key]) => name === "lookup" && key === "b"),
    );
  },
);

test(
  "real SDK protocol: rejection, fail-fast all, any and allSettled replay identically",
  {
    timeout: 8000,
  },
  async () => {
    const rejectedProgram = `async tools => {
  const seen=[];
  const a=tools.lookup('a').then(v=>{seen.push(v);return v;});
  const b=tools.lookup('b').catch(e=>{seen.push(e.message);throw e;});
  const settled=Promise.allSettled([a,b]);
  const any=Promise.any([a,b]);
  let firstError;
  try {await Promise.all([a,b]);} catch(e) {firstError=e.message;await tools.record(firstError);}
  return {firstError,any:await any,statuses:(await settled).map(x=>x.status),seen};
 }`;
    const liveFailure = await attempt([], rejectedProgram, true);
    const replayFailure = await attempt(
      liveFailure.journal,
      rejectedProgram,
      true,
    );
    assert.deepEqual(replayFailure.output, liveFailure.output);
    assert.deepEqual(replayFailure.issued, liveFailure.issued);
    assert.deepEqual(replayFailure.effects, []);
    const failureCut = liveFailure.journal.findIndex(
      (f) => f.readUInt16BE(0) === 0x8011,
    );
    const partialFailure = await attempt(
      liveFailure.journal.slice(0, failureCut + 1),
      rejectedProgram,
      true,
    );
    assert.deepEqual(partialFailure.output, liveFailure.output);
    assert.deepEqual(partialFailure.issued, liveFailure.issued);
    assert.deepEqual(liveFailure.output, {
      firstError: "b failed",
      any: "a",
      statuses: ["fulfilled", "rejected"],
      seen: ["b failed", "a"],
    });
    assert.ok(
      !partialFailure.effects.some(
        ([name, key]) => name === "lookup" && key === "b",
      ),
    );
  },
);
