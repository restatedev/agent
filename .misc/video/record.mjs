// Records the README video: a real turn on the real stack, with the agent
// service killed while the turn waits on a durable timer. See README.md here.
//
// It starts and kills the core service itself, drives the web UI in headless
// Chrome, polls the turn's journal from the Restate Admin API, and composes
// everything on director.html. The director's screencast frames are written to
// <out>/frames with the output time of each frame, for encode.sh.
import {spawn} from "node:child_process";
import {mkdirSync, rmSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";

import {launchChrome} from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const OUT = resolve(process.argv[2] ?? join(HERE, "out"));

const AGENT_ID = process.env.AGENT_ID ?? `demo-${Date.now().toString(36)}`;
const UI_URL = process.env.UI_URL ?? "http://127.0.0.1:3000";
const ADMIN_URL = process.env.RESTATE_ADMIN_URL ?? "http://localhost:9070";
const SLEEP_SECONDS = 30;
const PROMPT =
  `Get the weather in Berlin, Tokyo and New York in parallel. ` +
  `Then sleep for ${SLEEP_SECONDS} seconds. Then compare the three cities in two sentences.`;

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------
// Output timeline. Frames carry the wall-clock time they were painted; the
// speed segments map that to video time, so waiting stretches play faster.

const speedSegments = [{at: Date.now() / 1000, factor: 1}];
const frames = [];

function videoTime(seconds) {
  let time = 0;
  for (let i = 0; i < speedSegments.length; i++) {
    const segment = speedSegments[i];
    const end = speedSegments[i + 1]?.at ?? Infinity;
    if (seconds <= segment.at) break;
    time += (Math.min(seconds, end) - segment.at) / segment.factor;
  }
  return time;
}

async function setSpeed(stage, factor) {
  speedSegments.push({at: Date.now() / 1000, factor});
  await stage.evaluate(`stage.speed(${factor})`);
}

// ---------------------------------------------------------------------------
// The agent service: started, killed and restarted by this script, its log
// lines shown in the terminal panel.

let service;
let onServiceLine = () => {};

function startService() {
  service = spawn("node", ["./dist/app.js"], {
    cwd: join(REPO, "packages/libs/core"),
    env: {...process.env, NODE_ENV: "production"},
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [service.stdout, service.stderr]) {
    createInterface({input: stream}).on("line", (line) => onServiceLine(line));
  }
  return service.pid;
}

// "[restate][2026-...Z][AgentSession/demo/doTurn][inv_...] INFO: Replaying invocation."
function formatServiceLine(line) {
  const match = line.match(/^\[restate\]\[[^\]]*T([\d:]+)\.\d+Z\](?:\[([^\]]+)\]\[[^\]]+\])? \w+: (.*)$/);
  if (!match) return null;
  const [, time, target, message] = match;
  if (!target) return message.startsWith("Restate SDK started") ? {text: `${time}  listening on :9080`} : null;
  const handler = target.split("/").pop();
  if (!["doTurn", "ask"].includes(handler)) return null;
  const service = target.startsWith("AgentSession") ? "AgentSession" : "Agent";
  const text = `${time}  ${service}.${handler}  ${message}`;
  return {text, kind: message.startsWith("Replaying") ? "hot" : ""};
}

// ---------------------------------------------------------------------------
// The turn's journal, read from the Restate Admin API.

async function query(sql) {
  const response = await fetch(`${ADMIN_URL}/query`, {
    method: "POST",
    headers: {"content-type": "application/json", accept: "application/json"},
    body: JSON.stringify({query: sql}),
  });
  return (await response.json()).rows ?? [];
}

async function currentTurnId() {
  const rows = await query(
    `SELECT id FROM sys_invocation WHERE target_service_name = 'AgentSession' ` +
      `AND target_handler_name = 'doTurn' AND target_service_key = '${AGENT_ID}' ` +
      `ORDER BY created_at DESC LIMIT 1`,
  );
  return rows[0]?.id;
}

async function journalEntries(turnId) {
  return query(
    `SELECT index, entry_type, name FROM sys_journal WHERE id = '${turnId}' ` +
      `AND entry_type IN ('Command: Input', 'Command: Run', 'Command: Sleep', 'Command: Output', ` +
      `'Notification: Run', 'Notification: Sleep') ORDER BY index`,
  );
}

const LABELS = {
  "agent-model": "model call",
  getWeather: "getWeather",
  "discover-agent-tools": "tool catalog",
};

// Turns journal entries into panel rows. A run counts as recorded once as many
// run results as runs up to it are in the journal; parallel runs finish within
// milliseconds of each other, so the order does not show.
function journalRows(entries, replay) {
  const rows = [];
  const runResults = entries.filter((entry) => entry.entry_type === "Notification: Run").length;
  const sleepDone = entries.some((entry) => entry.entry_type === "Notification: Sleep");
  let runs = 0;
  for (const entry of entries) {
    const row = {index: entry.index, label: "", name: "", state: "wait", status: "running…"};
    if (entry.entry_type === "Command: Input") {
      Object.assign(row, {label: "input", name: "the message", state: "done", status: "✓ recorded"});
    } else if (entry.entry_type === "Command: Output") {
      Object.assign(row, {label: "output", name: "turn finished", state: "done", status: "✓ recorded"});
    } else if (entry.entry_type === "Command: Run") {
      runs++;
      const recorded = runs <= runResults;
      const name = LABELS[entry.name] ?? entry.name;
      const isTool = !LABELS[entry.name] || entry.name === "getWeather";
      Object.assign(row, {
        label: isTool ? "tool" : "",
        name,
        state: recorded ? "done" : "wait",
        status: recorded ? "✓ recorded" : "running…",
      });
    } else if (entry.entry_type === "Command: Sleep") {
      Object.assign(row, {
        label: "timer",
        name: `sleep ${SLEEP_SECONDS}s`,
        state: sleepDone ? "done" : "wait",
        status: sleepDone ? "✓ fired" : "⏱ in Restate",
      });
    } else {
      continue;
    }
    if (replay.replayed.has(entry.index)) Object.assign(row, {state: "replayed", status: "♻ replayed"});
    else if (replay.crashedAt !== undefined && entry.index > replay.crashedAt && row.state === "done") {
      Object.assign(row, {state: "fresh", status: "✓ new"});
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------

async function main() {
  rmSync(OUT, {recursive: true, force: true});
  mkdirSync(join(OUT, "frames"), {recursive: true});

  const browser = await launchChrome();
  const stage = await browser.newTab({url: `file://${HERE}/director.html`, width: 1920, height: 1080});
  // Both UIs render zoomed in, so they stay legible in a README-sized player.
  // The web UI's agent picker is cropped off the top: the conversation is the
  // part the video is about.
  const uiScale = 1100 / 900;
  // The UI opens only once the service runs (its default agent is "demo" too).
  // Opened earlier, its calls to the agent would wait in Restate's retry
  // backoff, and the first ask behind them.
  const ui = await browser.newTab({url: "about:blank", width: 900, height: 900, scale: uiScale});
  async function openUi() {
    await ui.goto(`${UI_URL}/?agent=${AGENT_ID}`);
    const pickerHeight = await ui.waitFor(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Open agent")?.getBoundingClientRect().bottom`,
    );
    const cropCss = pickerHeight + 13;
    await ui.send("Emulation.setDeviceMetricsOverride", {
      width: 900,
      height: Math.round(768 / uiScale + cropCss),
      deviceScaleFactor: uiScale,
      mobile: false,
    });
    await stage.evaluate(`stage.uiCrop(${Math.round(cropCss * uiScale)})`);
  }
  const restateScale = 1.25;
  const restateUi = await browser.newTab({
    url: "about:blank",
    width: Math.round(1840 / restateScale),
    height: Math.round(768 / restateScale),
    scale: restateScale,
  });

  // Stream a tab into the director. Only the newest frame is forwarded.
  function mirror(tab, method) {
    let latest;
    let busy = false;
    tab.on("Page.screencastFrame", async ({data, sessionId}) => {
      tab.send("Page.screencastFrameAck", {sessionId});
      latest = data;
      if (busy) return;
      busy = true;
      while (latest) {
        const frame = latest;
        latest = undefined;
        await stage.evaluate(`stage.${method}(${JSON.stringify(frame)})`);
      }
      busy = false;
    });
    return tab.send("Page.startScreencast", {format: "jpeg", quality: 92, maxWidth: 4096, maxHeight: 4096});
  }

  let frameNumber = 0;
  stage.on("Page.screencastFrame", ({data, metadata, sessionId}) => {
    stage.send("Page.screencastFrameAck", {sessionId});
    const file = `${String(frameNumber++).padStart(6, "0")}.jpg`;
    writeFileSync(join(OUT, "frames", file), Buffer.from(data, "base64"));
    frames.push({file, time: videoTime(metadata.timestamp)});
  });

  await mirror(ui, "uiFrame");
  await mirror(restateUi, "restateFrame");

  const say = (expression) => stage.evaluate(expression);
  const js = JSON.stringify;

  onServiceLine = (line) => {
    const formatted = formatServiceLine(line);
    if (formatted) say(`stage.line(${js(formatted.text)}, ${js(formatted.kind ?? "")})`);
  };

  async function typeCommand(command) {
    await say("stage.prompt()");
    for (const char of command) {
      await say(`stage.typeChar(${js(char)})`);
      await pause(38);
    }
    await pause(350);
  }

  const replay = {replayed: new Set(), crashedAt: undefined};
  let turnId;
  let entries = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      turnId ??= await currentTurnId();
      if (turnId) {
        entries = await journalEntries(turnId);
        await say(`stage.journal(${js(journalRows(entries, replay))})`);
      }
      await pause(250);
    }
  })();

  // --- Title ---------------------------------------------------------------
  await say(`stage.card("Restate reference agent", "Kill it mid-turn.", "A real turn, a real crash, no lost work.")`);
  await stage.send("Page.startScreencast", {format: "jpeg", quality: 90});
  await pause(3200);
  await say("stage.hideCard()");

  // --- 1. Start the service and ask ---------------------------------------
  await say(`stage.caption(1, "Start the agent and ask for something slow", "Three tools in parallel, then a ${SLEEP_SECONDS}-second durable timer.")`);
  await typeCommand("node dist/app.js");
  let pid = startService();
  await say(`stage.service("running", "RUNNING · PID ${pid}")`);
  await pause(800);
  await openUi();
  await pause(700);

  // The UI shows "Live" once its notification stream to the agent is up.
  await ui.waitFor(`document.body.innerText.includes("Live")`);
  const composer = `document.querySelector('textarea[aria-label="Ask message"]')`;
  await ui.evaluate(`${composer}.focus()`);
  await ui.type(PROMPT, {delayMs: 22});
  await pause(400);
  await ui.press("Enter");
  await ui.waitFor(`${composer}.value === ""`, {timeoutMs: 30_000});

  // --- 2. Journal fills -----------------------------------------------------
  while (!turnId) await pause(100);
  await say(`stage.caption(2, "Every step lands in the turn's journal", "Model calls and tool results are stored in Restate as they finish.")`);
  const quiet = () => {
    const sleeping = entries.some((entry) => entry.entry_type === "Command: Sleep");
    const runs = entries.filter((entry) => entry.entry_type === "Command: Run").length;
    const results = entries.filter((entry) => entry.entry_type === "Notification: Run").length;
    return sleeping && runs === results;
  };
  while (!quiet()) await pause(200);
  await pause(2500);
  // The model may take one more step while it waits; kill only when no run is open.
  while (!quiet()) await pause(200);

  // --- 3. Kill ----------------------------------------------------------------
  await say(`stage.caption(3, "Kill the service mid-turn", "kill -9: no shutdown, no warning. The timer is still running.")`);
  await typeCommand(`kill -9 ${pid}`);
  replay.crashedAt = entries.at(-1).index;
  service.kill("SIGKILL");
  await say("stage.crash()");
  await say(`stage.service("down", "KILLED")`);
  await say(`stage.line("[1]+  Killed: 9    node dist/app.js", "bad")`);
  await pause(2200);
  await say(`stage.caption(3, "No process is running this turn", "Restate holds its journal and its timer. Nothing is lost.")`);
  await setSpeed(stage, 4);
  await pause(8000);
  await setSpeed(stage, 1);

  // --- 4. Restart and replay ------------------------------------------------
  await say(`stage.caption(4, "Start it again", "Restate replays the journal. Recorded results are reused, not re-run.")`);
  await typeCommand("node dist/app.js");
  await say(`stage.service("starting", "STARTING")`);
  const replaying = new Promise((done) => {
    const previous = onServiceLine;
    onServiceLine = (line) => {
      previous(line);
      if (line.includes("doTurn") && line.includes("Replaying invocation")) done();
    };
  });
  pid = startService();
  await replaying;
  await say(`stage.service("running", "RUNNING · PID ${pid}")`);

  // Only finished steps are replayed from their recorded result; the timer is
  // still pending in Restate and keeps its own status.
  const recorded = journalRows(entries, replay).filter(
    (row) => row.index <= replay.crashedAt && row.state === "done",
  );
  for (const row of recorded) {
    replay.replayed.add(row.index);
    await say(`stage.journal(${js(journalRows(entries, replay))})`);
    await pause(140);
  }
  const models = recorded.filter((row) => row.name === "model call").length;
  const tools = recorded.filter((row) => row.label === "tool").length;
  await say(
    `stage.journalFoot(${js(`Replayed ${models} model calls and ${tools} tool calls. None ran again.`)})`,
  );

  // --- 5. The turn finishes ---------------------------------------------------
  await pause(2500);
  await say(`stage.caption(5, "The turn finishes where it stopped", "The timer fires on schedule and the model writes its answer.")`);
  await setSpeed(stage, 4);
  while (!entries.some((entry) => entry.entry_type === "Command: Output")) await pause(200);
  await setSpeed(stage, 1);
  await pause(4000);

  // --- 6. The Restate UI ----------------------------------------------------
  await restateUi.goto(`${ADMIN_URL}/ui/invocations/${turnId}`);
  await pause(2500);
  await say(`stage.caption(6, "Inspect it in the Restate UI", "One invocation, every step of the turn, across the crash.")`);
  await say("stage.showRestate(true)");
  await pause(2500);
  // Scroll to the timer: its bar spans the time the service was down.
  await restateUi.evaluate(`(() => {
    const timer = [...document.querySelectorAll("span")].find((span) => span.textContent.trim() === "sleep");
    const top = timer.getBoundingClientRect().top + scrollY - innerHeight / 2;
    scrollTo({top, behavior: "smooth"});
  })()`);
  await pause(2000);
  await say(`stage.caption(6, "The timer kept running while the service was down", "It fired on schedule, and the turn went on from the next step.")`);
  await pause(4000);

  // --- End card ---------------------------------------------------------------
  await say(`stage.card("github.com/restatedev/agent", "Durable by default.", "Every model call, tool and timer — journaled by <b>Restate</b>.")`);
  await pause(3500);

  polling = false;
  await poller;
  await stage.send("Page.stopScreencast");
  frames.push({file: frames.at(-1).file, time: videoTime(Date.now() / 1000)});
  writeFileSync(join(OUT, "frames.json"), JSON.stringify(frames));
  service.kill();
  await browser.close();
  console.log(`${frames.length} frames, ${frames.at(-1).time.toFixed(1)}s, agent ${AGENT_ID}, turn ${turnId}`);
}

main().catch((error) => {
  console.error(error);
  service?.kill("SIGKILL");
  process.exit(1);
});
