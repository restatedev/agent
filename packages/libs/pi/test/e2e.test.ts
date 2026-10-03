// End to end against a disposable Restate server (admin :9070, ingress
// :8080 by default; override with RESTATE_ADMIN_URL / RESTATE_INGRESS_URL).
// Skipped when no server answers. The test endpoint runs as a child process
// that is restarted whenever it exits, so a tool can crash it mid-run.

import assert from "node:assert/strict";
import {type ChildProcess, spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, before, test} from "node:test";
import {setTimeout as sleep} from "node:timers/promises";

const admin = process.env.RESTATE_ADMIN_URL ?? "http://127.0.0.1:9070";
const ingress = process.env.RESTATE_INGRESS_URL ?? "http://127.0.0.1:8080";
const port = Number(process.env.PI_TEST_PORT ?? 19081);
const crashMarker = join(mkdtempSync(join(tmpdir(), "pi-restate-")), "crashed");

const available = await fetch(`${admin}/health`).then(
  (response) => response.ok,
  () => false,
);

type Entry = {kind: string; model?: {role: string; content: unknown}[]};

let child: ChildProcess | undefined;
let stopping = false;
let starts = 0;

function startService(): Promise<void> {
  starts++;
  const started = spawn(
    process.execPath,
    ["--import", "tsx", "test/service.ts"],
    {
      env: {...process.env, PORT: String(port), PI_CRASH_MARKER: crashMarker},
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child = started;
  started.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  started.on("exit", () => {
    if (!stopping) void startService();
  });
  return new Promise((resolve) => {
    started.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) resolve();
    });
  });
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ingress}/${path}`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body ?? null),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Waits until the entity's pump has ended and nothing is pending. */
async function settled(key: string): Promise<Entry[]> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = await call<{pump: string | null; pending: number}>(
      `Pi/${key}/status`,
    );
    if (status.pump === null && status.pending === 0)
      return call<Entry[]>(`PiPump/${key}/entries`);
    await sleep(200);
  }
  throw new Error(`Entity ${key} did not settle`);
}

function texts(entries: Entry[]): string[] {
  return entries.flatMap((entry) =>
    (entry.model ?? [])
      .filter((message) => message.role !== "system")
      .map((message) => `${message.role}: ${render(message.content)}`),
  );
}

function render(content: unknown): string {
  if (typeof content === "string") return content;
  return (content as {type: string; text?: string; name?: string}[])
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "toolCall"
          ? `call ${part.name}`
          : "",
    )
    .join("");
}

before(async () => {
  if (!available) return;
  await startService();
  const registered = await fetch(`${admin}/deployments`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({uri: `http://127.0.0.1:${port}`, force: true}),
  });
  assert.ok(registered.ok, await registered.text());
});

after(() => {
  stopping = true;
  child?.kill();
});

test(
  "answers, then answers again from state in a new pump",
  {skip: !available},
  async () => {
    const key = randomUUID();
    await call(`Pi/${key}/submit`, {requestId: "a", text: "hello"});
    assert.deepEqual(texts(await settled(key)), [
      "user: hello",
      "assistant: echo: hello",
    ]);

    await call(`Pi/${key}/submit`, {requestId: "b", text: "again"});
    assert.deepEqual(texts(await settled(key)), [
      "user: hello",
      "assistant: echo: hello",
      "user: again",
      "assistant: echo: again",
    ]);
  },
);

test(
  "a duplicate request ID is answered once",
  {skip: !available},
  async () => {
    const key = randomUUID();
    await call(`Pi/${key}/submit`, {requestId: "same", text: "once"});
    await call(`Pi/${key}/submit`, {requestId: "same", text: "once"});
    assert.deepEqual(texts(await settled(key)), [
      "user: once",
      "assistant: echo: once",
    ]);
  },
);

test(
  "controls sent while a pump runs are delivered as signals",
  {skip: !available},
  async () => {
    const key = randomUUID();
    await Promise.all(
      ["one", "two", "three"].map((text) =>
        call(`Pi/${key}/submit`, {requestId: text, text}),
      ),
    );
    const answered = texts(await settled(key)).filter((line) =>
      line.startsWith("assistant"),
    );
    assert.deepEqual(answered.toSorted(), [
      "assistant: echo: one",
      "assistant: echo: three",
      "assistant: echo: two",
    ]);
  },
);

test(
  "a crash inside an unsafe tool resumes from the journal",
  {skip: !available},
  async () => {
    const key = randomUUID();
    const before = starts;
    await call(`Pi/${key}/submit`, {requestId: "t", text: "use tool"});
    const lines = texts(await settled(key));
    assert.ok(starts > before, "the endpoint process was restarted");
    assert.equal(lines[0], "user: use tool");
    assert.equal(lines[1], "assistant: call crashy");
    // Pi's own recovery: the unsafe tool is reported interrupted, not rerun.
    assert.match(
      lines[2]!,
      /^toolResult: .*interrupted and may have partially run/s,
    );
    assert.match(lines[3]!, /^assistant: after tool: .*interrupted/s);
    assert.equal(lines.length, 4);
  },
);
