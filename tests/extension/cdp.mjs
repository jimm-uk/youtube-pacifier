// Minimal Chrome DevTools Protocol helpers for driving Brave in the test VM.
// Node 22+ (global WebSocket). Never run on the host — see CLAUDE.md.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launchBrave({ brave, extension, port = 9333, headless = true }) {
  const profile = mkdtempSync(join(tmpdir(), "pacifier-profile-"));
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    // Recent Chromium ignores --load-extension; loading over the debugging
    // pipe (Extensions.loadUnpacked) is the supported route for automation.
    "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    "--no-first-run", "--no-default-browser-check", "--mute-audio",
    "--autoplay-policy=no-user-gesture-required", "--window-size=1280,1000",
  ];
  if (headless) args.unshift("--headless=new");
  const proc = spawn(brave, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", d => { stderr += d; });
  for (let i = 0; i < 60; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const extId = await pipeCall(proc, "Extensions.loadUnpacked", { path: extension });
      return { proc, port, profile, ws: v.webSocketDebuggerUrl, extId: extId.id, stderr: () => stderr };
    } catch (e) {
      if (String(e.message).startsWith("CDP")) { proc.kill(); throw e; }
      await sleep(500);
    }
  }
  proc.kill();
  throw new Error("Brave did not start:\n" + stderr.slice(-2000));
}

// One request/response over --remote-debugging-pipe (fd 3 in, fd 4 out, NUL-separated).
let pipeId = 1, pipeBuf = "";
function pipeCall(proc, method, params) {
  const id = pipeId++;
  return new Promise((resolve, reject) => {
    const onData = d => {
      pipeBuf += d;
      let i;
      while ((i = pipeBuf.indexOf("\0")) >= 0) {
        const msg = JSON.parse(pipeBuf.slice(0, i));
        pipeBuf = pipeBuf.slice(i + 1);
        if (msg.id === id) {
          proc.stdio[4].off("data", onData);
          msg.error ? reject(new Error("CDP " + msg.error.message)) : resolve(msg.result);
        }
      }
    };
    proc.stdio[4].on("data", onData);
    proc.stdio[3].write(JSON.stringify({ id, method, params }) + "\0");
  });
}

export async function extensionId(port, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const sw = list.find(t => t.url.startsWith("chrome-extension://"));
    if (sw) return new URL(sw.url).host;
    await sleep(500);
  }
  throw new Error("extension did not load (no chrome-extension:// target)");
}

export class CDP {
  static async connect(url) {
    const c = new CDP();
    c.ws = new WebSocket(url);
    c.next = 1;
    c.pending = new Map();
    c.listeners = [];
    c.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { resolve, reject } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) {
        for (const l of c.listeners) l(m);
      }
    };
    await new Promise((res, rej) => { c.ws.onopen = res; c.ws.onerror = rej; });
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.listeners.push(fn); }
  close() { this.ws.close(); }
}

// Open a page and return a function that evaluates JS in it.
export async function openPage(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  const evaluate = async expr => {
    const r = await cdp.send("Runtime.evaluate",
      { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const screenshot = async () =>
    Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId)).data, "base64");
  return { targetId, sessionId, evaluate, screenshot };
}

export async function waitFor(fn, timeoutMs = 20000, every = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}
