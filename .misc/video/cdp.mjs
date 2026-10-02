// A minimal Chrome DevTools Protocol client: launches headless Chrome, opens
// tabs and sends commands to them. Node 22+ only (built-in WebSocket), so the
// recorder needs no npm packages.
import {spawn} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function launchChrome({port = 9333} = {}) {
  const profile = mkdtempSync(join(tmpdir(), "readme-video-chrome-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--no-proxy-server",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    {stdio: "ignore"},
  );
  const url = await waitForDebugger(port);
  const browser = new Browser(new WebSocket(url), chrome);
  await browser.opened;
  return browser;
}

async function waitForDebugger(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return (await response.json()).webSocketDebuggerUrl;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Chrome did not start its debugger");
}

class Browser {
  constructor(socket, process) {
    this.socket = socket;
    this.process = process;
    this.nextId = 1;
    this.waiting = new Map();
    this.listeners = new Map();
    this.opened = new Promise((resolve) => socket.addEventListener("open", resolve));
    socket.addEventListener("message", (message) => this.receive(JSON.parse(message.data)));
  }

  receive(message) {
    if (message.id !== undefined) {
      const waiter = this.waiting.get(message.id);
      this.waiting.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    const key = `${message.sessionId ?? ""}:${message.method}`;
    for (const listener of this.listeners.get(key) ?? []) listener(message.params);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({id, method, params, sessionId}));
    return new Promise((resolve, reject) => this.waiting.set(id, {resolve, reject}));
  }

  on(sessionId, method, listener) {
    const key = `${sessionId}:${method}`;
    this.listeners.set(key, [...(this.listeners.get(key) ?? []), listener]);
  }

  async newTab({url, width, height, scale = 1}) {
    const {targetId} = await this.send("Target.createTarget", {url: "about:blank", newWindow: true});
    const {sessionId} = await this.send("Target.attachToTarget", {targetId, flatten: true});
    const tab = new Tab(this, sessionId);
    await tab.send("Page.enable");
    await tab.send("Runtime.enable");
    await tab.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    if (url) await tab.goto(url);
    return tab;
  }

  /** Closes Chrome and waits for it to exit, so no renderers are left behind. */
  async close() {
    const exited = new Promise((resolve) => this.process.once("exit", resolve));
    await this.send("Browser.close").catch(() => {});
    this.socket.close();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    this.process.kill("SIGKILL");
  }
}

class Tab {
  constructor(browser, sessionId) {
    this.browser = browser;
    this.sessionId = sessionId;
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  on(method, listener) {
    this.browser.on(this.sessionId, method, listener);
  }

  async goto(url) {
    const loaded = new Promise((resolve) => this.on("Page.loadEventFired", resolve));
    await this.send("Page.navigate", {url});
    await loaded;
  }

  async evaluate(expression) {
    const {result, exceptionDetails} = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? expression);
    return result.value;
  }

  /** Polls a page expression until it is truthy. */
  async waitFor(expression, {timeoutMs = 120_000, intervalMs = 200} = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.evaluate(expression);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  }

  async screenshot() {
    const {data} = await this.send("Page.captureScreenshot", {format: "png"});
    return Buffer.from(data, "base64");
  }

  /** Types text into the focused element, one key event per character. */
  async type(text, {delayMs = 35} = {}) {
    for (const char of text) {
      await this.send("Input.insertText", {text: char});
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  async press(key) {
    const codes = {Enter: 13};
    const event = {key, code: key, windowsVirtualKeyCode: codes[key], text: key === "Enter" ? "\r" : undefined};
    await this.send("Input.dispatchKeyEvent", {type: "keyDown", ...event});
    await this.send("Input.dispatchKeyEvent", {type: "keyUp", ...event});
  }
}
