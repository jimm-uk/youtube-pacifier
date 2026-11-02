// The "refresh running" marker never leaves Pacifier stuck:
//  1. close the page mid-refresh → a new page refreshes straight away;
//  2. a refresh running in another open tab → this tab says so, then shows
//     the list when that refresh finishes.
//   tests/extension/vm-run.sh refresh-lock.mjs
import { launchBrave, CDP, openPage, waitFor, sleep } from "./cdp.mjs";

const [brave, extension] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const status = page => page.evaluate(`document.querySelector(".status")?.textContent || ""`);
const items = page => page.evaluate(`document.querySelectorAll(".item").length`);

const b = await launchBrave({ brave, extension });
const cdp = await CDP.connect(b.ws);
const URL_ = `chrome-extension://${b.extId}/portal.html`;
try {
  // 1. First open starts a refresh; close the tab while it's running.
  const a = await openPage(cdp, URL_);
  await waitFor(async () => /…$/.test(await status(a)), 15000);
  await sleep(1500);
  const lockLeft = await a.evaluate(`chrome.storage.local.get("running").then(r => r.running ?? null)`);
  await cdp.send("Target.closeTarget", { targetId: a.targetId });
  await sleep(500);
  const b2 = await openPage(cdp, URL_);
  const started = await waitFor(async () => /…$/.test(await status(b2)), 10000);
  const listed = await waitFor(async () => (await items(b2)) >= 10 && !/…$/.test(await status(b2)), 200000, 1000);
  check("closed mid-refresh: a new page refreshes straight away", lockLeft && started && listed,
        `marker left: ${JSON.stringify(lockLeft)}; status: "${await status(b2)}"; items: ${await items(b2)}`);

  // 2. Another open tab (b2) holds the marker; press Refresh now in a new tab.
  //    (Set the marker directly: with warm caches a real refresh can finish
  //    before the second tab gets a chance to click.)
  const b2Tab = await b2.evaluate(`chrome.tabs.getCurrent().then(t => t.id)`);
  await b2.evaluate(`chrome.storage.local.set({ running: { at: Date.now(), tab: ${b2Tab} } })`);
  const c = await openPage(cdp, URL_);
  await waitFor(() => c.evaluate(`!!document.querySelector(".refresh")`), 10000);
  await sleep(500);
  await c.evaluate(`document.querySelector(".refresh").click()`);
  const said = await waitFor(async () => /already running in another/.test(await status(c)), 10000);
  // The owning tab now refreshes for real (its own marker doesn't block it).
  await b2.evaluate(`document.querySelector(".refresh").click()`);
  const updated = await waitFor(async () => /^Updated/.test(await status(c)) && (await items(c)) >= 10, 200000, 1000);
  check("refresh busy in another tab: says so, then shows the list", said && updated, `status: "${await status(c)}"`);
} catch (e) {
  check("test ran to completion", false, e.stack);
} finally {
  cdp.close(); b.proc.kill(); await sleep(300);
}
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
