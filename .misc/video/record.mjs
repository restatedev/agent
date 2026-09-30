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
const INGRESS_URL = process.env.RESTATE_INGRESS_URL ?? "http://localhost:8080";
const SLEEP_SECONDS = 30;

const ASK =
  "Plan a weekend in Lisbon for me. Write a small program that searches the web for " +
  "the weekend forecast, the top museums and the best food markets all at once, " +
  "then save a short plan to lisbon.md.";
const STEER = "Make it vegetarian-friendly, and add a rainy-day option.";
const GUARDRAIL = {
  id: "approve-writes",
  rule: "Writing or changing a file in the workspace needs a person's approval first.",
};
const FLEET =
  "Now compare four alternatives to Lisbon for a spring weekend: give Porto, Seville, Valencia " +
  "and Barcelona each to its own sub-agent to research at the same time (web search only, " +
  "no files, three lines each). Then tell me which one beats Lisbon.";
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

const SHOWN_HANDLERS = ["ask", "steer", "resolveApproval", "doTurn"];
const SHORT_MESSAGES = {
  "Starting invocation.": "started",
  "Invocation completed successfully.": "completed",
  "Replaying invocation.": "replaying the journal",
};

// "[restate][2026-...Z][AgentSession/demo/doTurn][inv_...] INFO: Replaying invocation."
function formatServiceLine(line) {
  const match = line.match(/^\[restate\]\[[^\]]*T([\d:]+)\.\d+Z\](?:\[([^\]]+)\]\[[^\]]+\])? \w+: (.*)$/);
  if (!match) return null;
  const [, time, target, message] = match;
  if (!target) return message.startsWith("Restate SDK started") ? {text: `${time}  listening on :9080`} : null;
  const handler = target.split("/").pop();
  if (!SHOWN_HANDLERS.includes(handler)) return null;
  const service = target.startsWith("AgentSession") ? "AgentSession" : "Agent";
  const text = `${time}  ${service}.${handler}  ${SHORT_MESSAGES[message] ?? message}`;
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
  "guardrail-model": "guardrail check",
  "guardrail-review": "guardrail review",
  "discover-agent-tools": "tool catalog",
  provisionSandbox: "sandbox start",
  resumeSandbox: "sandbox resume",
  suspendSandbox: "sandbox suspend",
};

// Turns journal entries into panel rows. A run counts as recorded once as many
// run results as runs up to it are in the journal; parallel runs finish within
// milliseconds of each other, so the order does not show.
// What each signal the turn receives is, in the order this script sends them.
const signalNames = [];

function journalRows(entries, replay) {
  const rows = [];
  let signals = 0;
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
      Object.assign(row, {label: "signal", name: signalNames[signals++] ?? "", status: "✓ received"});
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
        name: "sleep",
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
  // The web UI renders 800 CSS pixels wide, its one-column layout, where the
  // Approvals panel sits under the conversation. The recording shortens the
  // conversation pane to fit the frame and crops off the agent picker; the
  // view slides down to the Approvals panel when a decision is pending.
  const UI_WIDTH = 800;
  const uiScale = 1240 / UI_WIDTH;
  const uiVisible = 828 / uiScale;
  // The UI opens only once the service runs (its default agent is "demo" too).
  // Opened earlier, its calls to the agent would wait in Restate's retry
  // backoff, and the first ask behind them.
  const ui = await browser.newTab({url: "about:blank", width: UI_WIDTH, height: 1400, scale: uiScale});
  let conversationTop = 0;
  async function openUi() {
    await ui.goto(`${UI_URL}/?agent=${AGENT_ID}`);
    await ui.waitFor(`Boolean(document.querySelector(".conversation-pane"))`);
    await ui.evaluate(`(() => {
      const style = document.createElement("style");
      style.textContent = ".conversation-pane { height: ${Math.floor(uiVisible) - 8}px !important; min-height: 0 !important; }";
      document.head.appendChild(style);
    })()`);
    conversationTop = await ui.evaluate(
      `document.querySelector(".conversation-pane").getBoundingClientRect().top + scrollY - 4`,
    );
    await say(`stage.uiView(${Math.round(conversationTop * uiScale)})`);
  }
  // Slides the view so the Approvals panel's buttons are in frame.
  async function showApprovals() {
    const bottom = await ui.evaluate(
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Approve").getBoundingClientRect().bottom + scrollY`,
    );
    await say(`stage.uiView(${Math.round((bottom + 24 - uiVisible) * uiScale)})`);
  }
  const showConversation = () => say(`stage.uiView(${Math.round(conversationTop * uiScale)})`);
  // Links to child agents appear above the conversation once there are
  // children; measure where it starts again.
  async function recrop() {
    conversationTop = await ui.evaluate(
      `document.querySelector(".conversation-pane").getBoundingClientRect().top + scrollY - 4`,
    );
    await showConversation();
  }
  const restateScale = 1.25;
  const restateUi = await browser.newTab({
    url: "about:blank",
    width: Math.round(1840 / restateScale),
    height: Math.round(768 / restateScale),
    scale: restateScale,
  });

  // Stream a tab into the director. Only the newest frame is forwarded.
  function mirror(tab, show) {
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
        await say(show(js(frame)));
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

  await mirror(ui, (frame) => `stage.uiFrame(${frame})`);
  await mirror(restateUi, (frame) => `stage.restateFrame(${frame})`);

  let speed = 1;
  async function setSpeed(factor) {
    if (factor === speed) return;
    speed = factor;
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
  const childTabs = [];
  const follower = (async () => {
    while (polling) {
      for (const tab of [ui, ...childTabs]) {
        await tab.evaluate(
          `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Latest")?.click()`,
        );
      }
      await pause(400);
    }
  })();

  // Waiting on the model plays faster: while fastForward is on and the only
  // open step of the turn is a model call, the video runs at 2×, and the
  // header badge says so.
  const THINKING = ["agent-model", "guardrail-model", "guardrail-review"];
  let fastForward = false;
  const thinking = () => {
    const runs = entries.filter((entry) => entry.entry_type === "Command: Run");
    return runs.length > count(entries, "Notification: Run") && THINKING.includes(runs.at(-1).name);
  };
  const speeder = (async () => {
    while (polling) {
      if (fastForward) await setSpeed(thinking() ? 2 : 1);
      await pause(100);
    }
  })();
  async function fastForwardModel(on) {
    fastForward = on;
    if (!on) await setSpeed(1);
  }

  async function waitForTurn(previous) {
    while (!turnId || turnId === previous) await pause(100);
    return turnId;
  }
  async function waitFor(condition) {
    while (!condition()) await pause(150);
  }
  const finished = () => count(entries, "Command: Output") > 0;

  // --- Setup, before the camera rolls ----------------------------------------
  // The service runs from the start, and the agent gets its guardrail.
  let pid = startService();
  await say(`stage.line("$ node dist/app.js", "cmd")`);
  await say(`stage.service("running", "RUNNING · PID ${pid}")`);
  await pause(1500);
  const ingress = (handler, body) =>
    fetch(`${INGRESS_URL}/Agent/${AGENT_ID}/${handler}`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(body),
    });
  await ingress("initialize", {name: AGENT_ID});
  await ingress("updateProfile", {guardrails: [GUARDRAIL]});
  await openUi();
  await ui.waitFor(`document.body.innerText.includes("Live")`);

  async function pendingApprovals() {
    const response = await fetch(`${INGRESS_URL}/Agent/${AGENT_ID}/approvals`, {method: "POST"});
    return response.json();
  }

  // --- Title ---------------------------------------------------------------
  await say(`stage.card("Restate reference agent", "A durable agent, for real.", "Programs, steering, approvals, sub-agents — and a crash.")`);
  await stage.send("Page.startScreencast", {format: "jpeg", quality: 90});
  await pause(3200);
  await say("stage.hideCard()");

  // --- Act 1: an ordinary turn ------------------------------------------------
  await say(`stage.caption(1, "Ask it for something", "A real model, real web search, a real sandbox.")`);
  await pause(800);
  await send("Ask", ASK);
  const firstTurn = await waitForTurn(undefined);
  await fastForwardModel(true);

  await waitFor(() => count(entries, "Command: Run", "webSearch") >= 2);
  await say(`stage.caption(2, "It writes a program to do the work", "Its three web searches run at once. Only the program's result enters the context.")`);

  // Steer once the program's searches are recorded. A steer that lands while
  // the program still runs hands the program to the turn's pending work, and
  // the model then spends its steps waiting on it: real, but another story.
  const searchesDone = () =>
    count(entries, "Command: Run", "webSearch") >= 3 &&
    count(entries, "Command: Run") === count(entries, "Notification: Run") + (thinking() ? 1 : 0);
  await waitFor(searchesDone);
  await fastForwardModel(false);
  await say(`stage.caption(3, "Steer it while it works", "A new instruction for the running turn. Nothing is cancelled.")`);
  signalNames.push("steer");
  await send("Steer", STEER);
  await fastForwardModel(true);
  await waitFor(() => count(entries, "Notification: Signal") > 0 || finished());
  if (!count(entries, "Notification: Signal")) throw new Error("The steer reached no running turn; record again.");
  await say(`stage.caption(3, "The steer reaches the model's next step", "Running tools finish; the plan in lisbon.md follows the new instruction.")`);

  // The guardrail holds every file write for a person. Approve each one from
  // the Approvals panel until the turn finishes.
  let approved = 0;
  while (!finished()) {
    const [pending] = await pendingApprovals();
    if (!pending) {
      await pause(200);
      continue;
    }
    await fastForwardModel(false);
    if (approved === 0) {
      await say(`stage.caption(4, "A guardrail asks you first", ${js(`"${GUARDRAIL.rule}" The turn waits for you, holding no process.`)})`);
      await pause(2200);
    }
    await showApprovals();
    await pause(approved === 0 ? 2600 : 1400);
    // Highlight the button for a moment, so the click shows, then click it.
    const approve = `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Approve")`;
    await ui.evaluate(`${approve}.style.boxShadow = "0 0 0 4px #3ddc97aa, 0 0 24px #3ddc97"`);
    await pause(700);
    signalNames.push("approval");
    await ui.evaluate(`${approve}.click()`);
    approved++;
    await pause(300);
    await showConversation();
    while ((await pendingApprovals()).some((approval) => approval.approvalId === pending.approvalId)) await pause(150);
    await say(`stage.caption(4, "Approved: the turn goes on", "The file is written and the agent answers.")`);
    await fastForwardModel(true);
  }
  if (approved === 0) throw new Error("The guardrail asked for no approval; record again.");
  await fastForwardModel(false);
  // Hold on the answer long enough to read it.
  await pause(6500);

  // --- The fleet: sub-agents in parallel ------------------------------------------
  await say(`stage.caption(5, "Hand the work to a fleet", "Four sub-agents, one per city, each with its own history and sandbox.")`);
  await send("Ask", FLEET);
  const fleetTurn = await waitForTurn(firstTurn);
  await fastForwardModel(true);

  // The children exist once the parent's createSubAgent calls ran. Each one
  // is a whole agent: open its own page, read-only, in a tile of the grid.
  let children = [];
  while (children.length < 4 && !finished()) {
    const response = await fetch(`${INGRESS_URL}/Agent/${AGENT_ID}/children`, {method: "POST"});
    children = await response.json();
    await pause(300);
  }
  await fastForwardModel(false);
  const TILE_WIDTH = 912;
  const tileScale = TILE_WIDTH / 730;
  const tileVisible = 384 / tileScale;
  for (const [index, child] of children.slice(0, 4).entries()) {
    const tab = await browser.newTab({url: "about:blank", width: 730, height: 1100, scale: tileScale});
    await tab.goto(`${UI_URL}/?agent=${child.agentId}`);
    await tab.waitFor(`Boolean(document.querySelector(".conversation-pane"))`);
    await tab.evaluate(`(() => {
      const style = document.createElement("style");
      style.textContent = ".conversation-pane { height: ${Math.floor(tileVisible) + 170}px !important; min-height: 0 !important; }";
      document.head.appendChild(style);
    })()`);
    const top = await tab.evaluate(
      `document.querySelector(".conversation-pane").getBoundingClientRect().top + scrollY + 64`,
    );
    await say(`stage.fleetTile(${index}, ${js(child.name)}, ${Math.round(top * tileScale)})`);
    await mirror(tab, (frame) => `stage.fleetFrame(${index}, ${frame})`);
    childTabs.push(tab);
  }
  await say("stage.showFleet(true)");
  await say(`stage.caption(5, "Four sub-agents work at once", "The parent's turn waits on all four, durably. Each child runs its own turns.")`);

  // Mark each child done when its turn completes.
  async function childTurnsDone() {
    const keys = children.map((child) => `'${child.agentId}'`).join(", ");
    const rows = await query(
      `SELECT target_service_key, status FROM sys_invocation WHERE target_service_name = 'AgentSession' ` +
        `AND target_handler_name = 'doTurn' AND target_service_key IN (${keys})`,
    );
    return children.map((child) =>
      rows.some((row) => row.target_service_key === child.agentId && row.status === "completed"),
    );
  }
  await pause(1500);
  await setSpeed(2);
  let done = [];
  while (done.filter(Boolean).length < children.length) {
    done = await childTurnsDone();
    for (const [index, isDone] of done.entries()) {
      await say(`stage.fleetStatus(${index}, ${isDone})`);
    }
    await pause(300);
  }
  await setSpeed(1);
  await pause(2500);
  await recrop();
  await say("stage.showFleet(false)");
  await say(`stage.caption(6, "The parent combines their answers", "Four results come back into one turn, which answers.")`);
  await fastForwardModel(true);
  await waitFor(() => turnId === fleetTurn && finished());
  await fastForwardModel(false);
  await pause(6500);

  // --- Act 2: kill it mid-turn ------------------------------------------------
  await say(`stage.card("Now the fun part", "Kill it mid-turn.", "A follow-up that waits ${SLEEP_SECONDS} seconds — and kill -9 in the middle.")`);
  await pause(2800);
  await say("stage.hideCard()");
  await say(`stage.caption(7, "Ask for something that takes a while", "A ${SLEEP_SECONDS}-second durable timer, then it reads the file back.")`);
  await send("Ask", FOLLOW_UP);
  await waitForTurn(fleetTurn);
  await fastForwardModel(true);

  // Kill only when the timer runs and no other step is open, so every step
  // before the crash has its result recorded.
  const quiet = () =>
    count(entries, "Command: Sleep") > 0 && count(entries, "Command: Run") === count(entries, "Notification: Run");
  await waitFor(quiet);
  await pause(2500);
  await waitFor(quiet);

  await fastForwardModel(false);
  await say(`stage.caption(8, "Kill the service mid-turn", "kill -9: no shutdown, no warning. The timer is still running.")`);
  await typeCommand(`kill -9 ${pid}`);
  replay.crashedAt = entries.at(-1).index;
  service.kill("SIGKILL");
  await say("stage.crash()");
  await say(`stage.service("down", "KILLED")`);
  await say(`stage.line("[1]+  Killed: 9    node dist/app.js", "bad")`);
  await pause(2200);
  await say(`stage.caption(8, "No process is running this turn", "Restate holds its journal and its timer. Nothing is lost.")`);
  await setSpeed(4);
  await pause(8000);
  await setSpeed(1);

  await say(`stage.caption(9, "Start it again", "Restate replays the journal. Recorded results are reused, not re-run.")`);
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
  await say(`stage.caption(10, "The turn finishes where it stopped", "The timer fires on schedule; the agent reads the file and answers.")`);
  await setSpeed(4);
  await waitFor(finished);
  await setSpeed(1);
  await pause(6500);

  // --- The Restate UI -----------------------------------------------------------
  await restateUi.goto(`${ADMIN_URL}/ui/invocations/${turnId}`);
  await pause(2500);
  await say(`stage.caption(11, "Inspect it in the Restate UI", "One invocation, every step of the turn, across the crash.")`);
  await say("stage.showRestate(true)");
  await pause(2500);
  // Scroll to the timer: its bar spans the time the service was down.
  await restateUi.evaluate(`(() => {
    const timer = [...document.querySelectorAll("span")].find((span) => span.textContent.trim() === "sleep");
    const top = timer.getBoundingClientRect().top + scrollY - innerHeight / 2;
    scrollTo({top, behavior: "smooth"});
  })()`);
  await pause(2000);
  await say(`stage.caption(11, "The timer kept running while the service was down", "It fired on schedule, and the turn went on from the next step.")`);
  await pause(4000);

  // --- End card ---------------------------------------------------------------
  await say(`stage.card("github.com/restatedev/agent", "Durable by default.", "Every model call, tool and timer — journaled by <b>Restate</b>.")`);
  await pause(3500);

  polling = false;
  await Promise.all([poller, follower, speeder]);
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
