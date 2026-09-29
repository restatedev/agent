// Records the README video: a real session with the reference agent on the
// real stack, in two acts. See README.md here.
//
//   1. A casual request: the model writes a program whose web searches run at
//      once, saves a plan in its sandbox, and is steered while it works.
//   2. A follow-up that waits on a durable timer. The service is killed with
//      kill -9 during the wait, started again, and Restate replays the turn.
//
// It starts and kills the core service itself, drives the web UI in headless
// Chrome, polls each turn's journal from the Restate Admin API, and composes
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

const ASK =
  "Plan a weekend in Lisbon for me. Write a small program that searches the web for " +
  "the weekend forecast, the top museums and the best food markets all at once, " +
  "then save a short plan to lisbon.md.";
const STEER = "Make it vegetarian-friendly, and add a rainy-day option.";
const FOLLOW_UP =
  `Give me ${SLEEP_SECONDS} seconds to run it by my partner: sleep for ${SLEEP_SECONDS} seconds, ` +
  "then read lisbon.md back and sum it up in three lines.";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const js = JSON.stringify;

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

// ---------------------------------------------------------------------------
// The agent service: started, killed and restarted by this script, its log
// lines shown in the terminal panel.

let service;
let browser;
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

const SHOWN_HANDLERS = ["ask", "steer", "doTurn"];

// "[restate][2026-...Z][AgentSession/demo/doTurn][inv_...] INFO: Replaying invocation."
function formatServiceLine(line) {
  const match = line.match(/^\[restate\]\[[^\]]*T([\d:]+)\.\d+Z\](?:\[([^\]]+)\]\[[^\]]+\])? \w+: (.*)$/);
  if (!match) return null;
  const [, time, target, message] = match;
  if (!target) return message.startsWith("Restate SDK started") ? {text: `${time}  listening on :9080`} : null;
  const handler = target.split("/").pop();
  if (!SHOWN_HANDLERS.includes(handler)) return null;
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

async function latestTurnId() {
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
      `'Notification: Run', 'Notification: Sleep', 'Notification: Signal') ORDER BY index`,
  );
}

// Runs the turn journals for itself rather than for a tool.
const STEPS = {
  "agent-model": "model call",
  "discover-agent-tools": "tool catalog",
  provisionSandbox: "sandbox start",
  resumeSandbox: "sandbox resume",
  suspendSandbox: "sandbox suspend",
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
    const row = {index: entry.index, label: "", name: "", state: "done", status: "✓ recorded"};
    if (entry.entry_type === "Command: Input") {
      Object.assign(row, {label: "input", name: "the message"});
    } else if (entry.entry_type === "Command: Output") {
      Object.assign(row, {label: "output", name: "turn finished"});
    } else if (entry.entry_type === "Notification: Signal") {
      Object.assign(row, {label: "signal", name: "steer", status: "✓ received"});
    } else if (entry.entry_type === "Command: Run") {
      runs++;
      const recorded = runs <= runResults;
      Object.assign(row, {
        label: STEPS[entry.name] ? "" : "tool",
        name: STEPS[entry.name] ?? entry.name,
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

const count = (entries, type, name) =>
  entries.filter((entry) => entry.entry_type === type && (name === undefined || entry.name === name)).length;

// ---------------------------------------------------------------------------

async function main() {
  rmSync(OUT, {recursive: true, force: true});
  mkdirSync(join(OUT, "frames"), {recursive: true});

  browser = await launchChrome();
  const stage = await browser.newTab({url: `file://${HERE}/director.html`, width: 1920, height: 1080});
  const say = (expression) => stage.evaluate(expression);

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
    await say(`stage.uiCrop(${Math.round(cropCss * uiScale)})`);
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
        await say(`stage.${method}(${js(frame)})`);
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

  async function setSpeed(factor) {
    speedSegments.push({at: Date.now() / 1000, factor});
    await say(`stage.speed(${factor})`);
  }

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

  // Sends a message from the UI composer in one of its modes (Ask, Steer).
  async function send(mode, text) {
    await ui.evaluate(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${js(mode)}).click()`,
    );
    const composer = `document.querySelector('textarea[aria-label="${mode} message"]')`;
    await ui.waitFor(`Boolean(${composer})`);
    await ui.evaluate(`${composer}.focus()`);
    await ui.type(text, {delayMs: 18});
    await pause(300);
    await ui.press("Enter");
    await ui.waitFor(`${composer}.value === ""`, {timeoutMs: 30_000});
  }

  // The journal panel follows the newest turn of the agent.
  let replay = {replayed: new Set(), crashedAt: undefined};
  let turnId;
  let entries = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const latest = await latestTurnId();
      if (latest && latest !== turnId) {
        turnId = latest;
        replay = {replayed: new Set(), crashedAt: undefined};
        await say("stage.journalReset()");
      }
      if (turnId) {
        entries = await journalEntries(turnId);
        await say(`stage.journal(${js(journalRows(entries, replay))})`);
      }
      await pause(250);
    }
  })();

  // The transcript stops following new events once they push it past the
  // fold; press its "Latest" button, as a viewer would.
  const follower = (async () => {
    while (polling) {
      await ui.evaluate(
        `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Latest")?.click()`,
      );
      await pause(400);
    }
  })();

  async function waitForTurn(previous) {
    while (!turnId || turnId === previous) await pause(100);
    return turnId;
  }
  async function waitFor(condition) {
    while (!condition()) await pause(150);
  }
  const finished = () => count(entries, "Command: Output") > 0;

  // --- Title ---------------------------------------------------------------
  await say(`stage.card("Restate reference agent", "A durable agent, for real.", "Tools, programs, steering — and a crash in the middle.")`);
  await stage.send("Page.startScreencast", {format: "jpeg", quality: 90});
  await pause(3200);
  await say("stage.hideCard()");

  // --- Act 1: an ordinary turn ------------------------------------------------
  await say(`stage.caption(1, "Ask it for something", "A real model, real web search, a real sandbox.")`);
  await typeCommand("node dist/app.js");
  let pid = startService();
  await say(`stage.service("running", "RUNNING · PID ${pid}")`);
  await pause(800);
  await openUi();
  await pause(700);
  await ui.waitFor(`document.body.innerText.includes("Live")`);
  await send("Ask", ASK);
  const firstTurn = await waitForTurn(undefined);

  await waitFor(() => count(entries, "Command: Run", "webSearch") >= 2);
  await say(`stage.caption(2, "It writes a program to do the work", "Its three web searches run at once. Only the program's result enters the context.")`);
  await pause(600);

  await say(`stage.caption(3, "Steer it while it works", "A new instruction for the running turn. Nothing is cancelled.")`);
  await send("Steer", STEER);
  await waitFor(() => count(entries, "Notification: Signal") > 0 || finished());
  if (!count(entries, "Notification: Signal")) throw new Error("The steer reached no running turn; record again.");
  await say(`stage.caption(3, "The steer reaches the model's next step", "Running tools finish; the plan in lisbon.md follows the new instruction.")`);
  await setSpeed(2);
  await waitFor(finished);
  await setSpeed(1);
  await pause(3500);

  // --- Act 2: kill it mid-turn ------------------------------------------------
  await say(`stage.card("Now the fun part", "Kill it mid-turn.", "A follow-up that waits ${SLEEP_SECONDS} seconds — and kill -9 in the middle.")`);
  await pause(2800);
  await say("stage.hideCard()");
  await say(`stage.caption(4, "Ask for something that takes a while", "A ${SLEEP_SECONDS}-second durable timer, then it reads the file back.")`);
  await send("Ask", FOLLOW_UP);
  await waitForTurn(firstTurn);

  // Kill only when the timer runs and no other step is open, so every step
  // before the crash has its result recorded.
  const quiet = () =>
    count(entries, "Command: Sleep") > 0 && count(entries, "Command: Run") === count(entries, "Notification: Run");
  await waitFor(quiet);
  await pause(2500);
  await waitFor(quiet);

  await say(`stage.caption(5, "Kill the service mid-turn", "kill -9: no shutdown, no warning. The timer is still running.")`);
  await typeCommand(`kill -9 ${pid}`);
  replay.crashedAt = entries.at(-1).index;
  service.kill("SIGKILL");
  await say("stage.crash()");
  await say(`stage.service("down", "KILLED")`);
  await say(`stage.line("[1]+  Killed: 9    node dist/app.js", "bad")`);
  await pause(2200);
  await say(`stage.caption(5, "No process is running this turn", "Restate holds its journal and its timer. Nothing is lost.")`);
  await setSpeed(4);
  await pause(8000);
  await setSpeed(1);

  await say(`stage.caption(6, "Start it again", "Restate replays the journal. Recorded results are reused, not re-run.")`);
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
  await say(`stage.journalFoot(${js(`Replayed ${recorded.length} recorded steps, ${models} of them model calls. None ran again.`)})`);

  await pause(2500);
  await say(`stage.caption(7, "The turn finishes where it stopped", "The timer fires on schedule; the agent reads the file and answers.")`);
  await setSpeed(4);
  await waitFor(finished);
  await setSpeed(1);
  await pause(4000);

  // --- The Restate UI -----------------------------------------------------------
  await restateUi.goto(`${ADMIN_URL}/ui/invocations/${turnId}`);
  await pause(2500);
  await say(`stage.caption(8, "Inspect it in the Restate UI", "One invocation, every step of the turn, across the crash.")`);
  await say("stage.showRestate(true)");
  await pause(2500);
  // Scroll to the timer: its bar spans the time the service was down.
  await restateUi.evaluate(`(() => {
    const timer = [...document.querySelectorAll("span")].find((span) => span.textContent.trim() === "sleep");
    const top = timer.getBoundingClientRect().top + scrollY - innerHeight / 2;
    scrollTo({top, behavior: "smooth"});
  })()`);
  await pause(2000);
  await say(`stage.caption(8, "The timer kept running while the service was down", "It fired on schedule, and the turn went on from the next step.")`);
  await pause(4000);

  // --- End card ---------------------------------------------------------------
  await say(`stage.card("github.com/restatedev/agent", "Durable by default.", "Every model call, tool and timer — journaled by <b>Restate</b>.")`);
  await pause(3500);

  polling = false;
  await Promise.all([poller, follower]);
  await stage.send("Page.stopScreencast");
  frames.push({file: frames.at(-1).file, time: videoTime(Date.now() / 1000)});
  writeFileSync(join(OUT, "frames.json"), JSON.stringify(frames));
  service.kill();
  await browser.close();
  console.log(`${frames.length} frames, ${frames.at(-1).time.toFixed(1)}s, agent ${AGENT_ID}`);
}

main().catch(async (error) => {
  console.error(error);
  service?.kill("SIGKILL");
  await browser?.close();
  process.exit(1);
});
