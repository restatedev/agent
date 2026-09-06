import assert from "node:assert/strict";
import {createEndpointHandler, service} from "@restatedev/restate-sdk/fetch";
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

export async function runHandler(handler, {replay = [], onProposal} = {}) {
  const input = frame(0x400, pb([14, pb([1, "{}"])]));
  const journal = [...(replay.length ? replay : [input])];
  let controller, output;
  const endpoint = createEndpointHandler({
    bidirectional: true,
    services: [service({name: "PTCTest", handlers: {run: handler}})],
  });
  const start = frame(
    0,
    pb(
      [1, Buffer.alloc(16, 1)],
      [2, "ptc-test-invocation"],
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
  const response = await endpoint(
    new Request("http://local/invoke/PTCTest/run", {
      method: "POST",
      headers: {"content-type": "application/vnd.restate.invocation.v7"},
      body,
      duplex: "half",
    }),
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let buffer = Buffer.alloc(0);
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer = cat(buffer, value);
      while (
        buffer.length >= 8 &&
        buffer.length >= 8 + buffer.readUInt32BE(4)
      ) {
        const size = 8 + buffer.readUInt32BE(4),
          f = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        const type = f.readUInt16BE(0),
          data = decode(f.subarray(8));
        if (type === 0x411) journal.push(Buffer.from(f));
        else if (type === 5) {
          const id = data.get(1) ?? 0;
          assert.ok(data.has(14), "run should return a recorded value");
          journal.push(frame(0x8011, pb([1, id], [5, pb([1, data.get(14)])])));
          controller.enqueue(frame(7, pb([1, id])));
          onProposal?.(JSON.parse(data.get(14).toString()));
        } else if (type === 0x401) {
          assert.ok(data.has(14), "handler should succeed");
          output = JSON.parse(decode(data.get(14)).get(1).toString());
          controller.close();
        } else if (type === 2) {
          throw new Error(
            "SDK failure: " +
              [...data].map(([k, v]) => [
                k,
                Buffer.isBuffer(v) ? v.toString() : v,
              ]),
          );
        } else if (type !== 3) {
          throw new Error(
            "Unsupported test protocol frame: " + type.toString(16),
          );
        }
      }
    }
  } finally {
    try {
      controller.close();
    } catch {}
    reader.releaseLock();
  }
  assert.notEqual(output, undefined);
  return {journal, output};
}
