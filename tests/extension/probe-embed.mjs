// List the visible clickable/overlay elements inside the YouTube embed while
// it plays in the portal — used to choose cosmetic-filter selectors.
//   tests/extension/vm-run.sh probe-embed.mjs
import { launchBrave, CDP, openPage, waitFor, sleep } from "./cdp.mjs";
const [brave, extension] = process.argv.slice(2);
const b = await launchBrave({ brave, extension });
const cdp = await CDP.connect(b.ws);
const frames = new Map();
cdp.on(m => {
  if (m.method === "Target.attachedToTarget") {
    const { sessionId, targetInfo } = m.params;
    if (targetInfo.type === "iframe") frames.set(sessionId, targetInfo.url);
    cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
    cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
  }
});
await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const page = await openPage(cdp, `chrome-extension://${b.extId}/portal.html`);
await waitFor(() => page.evaluate(`document.querySelectorAll(".item").length >= 10`), 180000, 1000);
const href = await page.evaluate(`document.querySelector(".item a").getAttribute("href")`);
await page.evaluate(`location.hash = ${JSON.stringify(href)}`);
await waitFor(() => page.evaluate("!!(window.pacifierPlayer && pacifierPlayer.ready)"), 30000);
await page.evaluate("pacifierPlayer.mute(); pacifierPlayer.play()");
const LIST = `[...document.querySelectorAll("*")].filter(e => {
  const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
  if (!r.width || !r.height || cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) return false;
  return e.matches("a, button, [role=button], [class*=overlay], [class*=endscreen], [class*=chrome-top], [class*=watermark], [class*=impression], [class*=more], [class*=suggest], [class*=title]");
}).map(e => e.tagName.toLowerCase() + "." + [...e.classList].join(".") + " [" + (e.getAttribute("aria-label") || "") + "] " + (e.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 40))`;
// The embed may be an out-of-process target or a frame in the page's process.
const contexts = [];
cdp.on(m => {
  if (m.method === "Runtime.executionContextCreated" && m.params.context.origin?.includes("youtube-nocookie"))
    contexts.push({ id: m.params.context.id, session: m.sessionId });
});
for (const s of [page.sessionId, ...frames.keys()]) await cdp.send("Runtime.enable", {}, s).catch(() => {});
console.log("iframe targets:", [...frames.values()].map(u => u.slice(0, 50)).join(", ") || "none", "| nocookie contexts:", contexts.length);
for (const when of [2000, 6000]) {
  await sleep(when);
  const runs = [
    ...[...frames].filter(([, u]) => u.includes("youtube-nocookie")).map(([s]) => ({ session: s })),
    ...contexts.map(c => ({ session: c.session, contextId: c.id })),
  ];
  for (const r of runs) {
    const out = await cdp.send("Runtime.evaluate", { expression: LIST, returnByValue: true, ...(r.contextId ? { contextId: r.contextId } : {}) }, r.session)
      .catch(e => ({ result: { value: [String(e)] } }));
    console.log(`--- ${when}ms after play`);
    console.log((out.result.value || []).join("\n"));
  }
}
cdp.close(); b.proc.kill(); await sleep(300);
