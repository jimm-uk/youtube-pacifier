// Run one refresh with every fetch timed; report slow/failed requests,
// the outcome and console errors.   tests/extension/vm-run.sh diagnose.mjs
import { launchBrave, CDP, openPage, waitFor, sleep } from "./cdp.mjs";
const [brave, extension] = process.argv.slice(2);
const b = await launchBrave({ brave, extension });
const cdp = await CDP.connect(b.ws);
const logs = [];
cdp.on(m => {
  if (m.method === "Runtime.exceptionThrown") logs.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
});
const EXT = `chrome-extension://${b.extId}`;
const settings = await openPage(cdp, `${EXT}/settings.html`);
await settings.evaluate(`chrome.storage.local.set({ config: { auto_refresh_hours: 0 } })`);
const page = await openPage(cdp, `${EXT}/portal.html`);
await sleep(1000);
await page.evaluate(`(() => {
  window.__fetches = [];
  const real = window.fetch;
  window.fetch = async (url, opts) => {
    const t = performance.now(), rec = { url: String(url).slice(0, 90), ms: null, result: "pending" };
    __fetches.push(rec);
    try { const r = await real(url, opts); rec.result = r.status + (r.redirected ? " redirected" : ""); return r; }
    catch (e) { rec.result = "error " + e.name + ": " + e.message; throw e; }
    finally { rec.ms = Math.round(performance.now() - t); }
  };
  document.querySelector(".refresh").click();
})()`);
const t0 = Date.now();
let last = "";
while (Date.now() - t0 < 200000) {
  await sleep(5000);
  const s = await page.evaluate(`({ status: document.querySelector(".status")?.textContent, n: __fetches.length,
    pending: __fetches.filter(f => f.result === "pending").map(f => f.url),
    done: !document.querySelector(".refresh").disabled })`);
  const line = `${Math.round((Date.now() - t0) / 1000)}s ${s.status} | fetches ${s.n}, pending ${s.pending.length}`;
  if (line.slice(line.indexOf(" ")) !== last) console.log(line);
  last = line.slice(line.indexOf(" "));
  if (s.pending.length && Date.now() - t0 > 60000) console.log("   pending:", s.pending.slice(0, 4).join(" | "));
  if (s.done) break;
}
const f = await page.evaluate(`__fetches`);
const slow = f.filter(x => x.ms > 5000 || x.result !== "200");
console.log(`fetches: ${f.length}; slow/failed: ${slow.length}`);
for (const x of slow.slice(0, 15)) console.log(`   ${x.ms}ms ${x.result} ${x.url}`);
const feed = await page.evaluate(`chrome.storage.local.get("feed").then(r => r.feed && { status: r.feed.status, error: r.feed.error, items: r.feed.items?.length, log: (r.feed.log || []).slice(0, 8) })`);
console.log("feed:", JSON.stringify(feed));
console.log(logs.join("\n") || "(no exceptions)");
cdp.close(); b.proc.kill(); await sleep(300);
