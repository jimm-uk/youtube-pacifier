// End-to-end test of the Pacifier extension in Brave (run in the VM only):
//   tests/extension/vm-run.sh e2e.mjs
// Plants fake login cookies for YouTube/Google, then checks a full refresh,
// the player (no autoplay, pause overlay, end -> back to list, watched),
// settings, and that no planted cookie is ever sent.
import { mkdirSync, writeFileSync } from "node:fs";
import { launchBrave, CDP, openPage, waitFor, sleep } from "./cdp.mjs";

const [brave, extension] = process.argv.slice(2);
const SHOTS = "/tmp/pacifier-shots";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const b = await launchBrave({ brave, extension });
const cdp = await CDP.connect(b.ws);
try {
  const id = b.extId;

  // --- record every request in every target (pages, iframes, workers) -----
  const requests = new Map();   // requestId -> {url, cookie, blocked}
  const errors = [];
  const embedContexts = [];   // execution contexts inside the YouTube embed
  cdp.on(async m => {
    const p = m.params || {};
    if (m.method === "Target.attachedToTarget") {
      const s = p.sessionId;
      cdp.send("Network.enable", {}, s).catch(() => {});
      cdp.send("Runtime.enable", {}, s).catch(() => {});
      cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, s).catch(() => {});
      cdp.send("Runtime.runIfWaitingForDebugger", {}, s).catch(() => {});
    } else if (m.method === "Network.requestWillBeSent") {
      requests.set(p.requestId, { ...(requests.get(p.requestId) || {}), url: p.request.url });
    } else if (m.method === "Network.requestWillBeSentExtraInfo") {
      const h = Object.fromEntries(Object.entries(p.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      requests.set(p.requestId, { ...(requests.get(p.requestId) || {}), cookie: h.cookie || "" });
    } else if (m.method === "Network.loadingFailed" && /BLOCKED_BY_CLIENT/.test(p.errorText || "")) {
      requests.set(p.requestId, { ...(requests.get(p.requestId) || {}), blocked: true });
    } else if (m.method === "Runtime.executionContextCreated" && m.params.context.origin?.includes("youtube-nocookie")) {
      embedContexts.push({ id: m.params.context.id, session: m.sessionId });
    } else if (m.method === "Runtime.exceptionThrown") {
      errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
    }
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  // --- plant fake "logged in" cookies --------------------------------------
  const fake = (domain, name) => ({ name, value: `FAKE-${domain}`, domain, path: "/",
                                    secure: true, httpOnly: true, sameSite: "None", expires: Date.now() / 1000 + 3600 });
  await cdp.send("Storage.setCookies", { cookies: [
    fake(".youtube.com", "SID"), fake(".youtube.com", "LOGIN_INFO"), fake(".google.com", "SID"),
    fake(".youtube-nocookie.com", "VISITOR_INFO1_LIVE"), fake(".googlevideo.com", "X"), fake(".ytimg.com", "X"),
  ] });

  // --- portal: first open triggers a refresh -------------------------------
  const t0 = Date.now();
  const portal = await openPage(cdp, `chrome-extension://${id}/portal.html`);
  const listed = await waitFor(() => portal.evaluate(
    `document.querySelectorAll(".item").length >= 10 && !/…$/.test(document.querySelector(".status")?.textContent || "")`), 240000, 1000);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const summary = await portal.evaluate(`({
    items: document.querySelectorAll(".item").length,
    list: document.querySelectorAll("ol.items:not(.suggestion ol) > .item").length,
    sugg: document.querySelectorAll(".suggestion .item").length,
    status: document.querySelector(".status")?.textContent,
    footer: document.querySelector("footer")?.textContent,
    titles: [...document.querySelectorAll(".item")].map(li => li.textContent.slice(0, 90)),
  })`);
  check("refresh builds 10 items", listed && summary.items === 10, `${summary.items} items in ${secs}s; status "${summary.status}"`);
  check("9 from the list + 1 suggestion (or 10 + 0)", (summary.sugg === 1 && summary.items - summary.sugg === 9) || (summary.sugg === 0 && summary.items === 10),
        `${summary.items - summary.sugg} + ${summary.sugg}`);
  for (const t of summary.titles) console.log("      ", t);
  if (summary.items < 10) {
    const f = await portal.evaluate(`chrome.storage.local.get(["feed", "running"]).then(r => ({ running: r.running, status: r.feed?.status, error: r.feed?.error, stage: r.feed?.stage, log: r.feed?.log }))`);
    console.log("      refresh outcome:", JSON.stringify(f));
  }
  writeFileSync(`${SHOTS}/1-list.png`, await portal.screenshot());

  // --- player ----------------------------------------------------------------
  const first = await portal.evaluate(`document.querySelector(".item a").getAttribute("href")`);
  await portal.evaluate(`location.hash = ${JSON.stringify(first)}`);
  const ready = await waitFor(() => portal.evaluate("!!(window.pacifierPlayer && pacifierPlayer.ready)"), 30000);
  check("player loads", ready);
  await sleep(3000);
  const st = () => portal.evaluate(`document.querySelector(".stage")?.dataset.state ?? "none"`);
  check("no autoplay", !["1", "3"].includes(await st()), `state ${await st()}`);
  await portal.evaluate("document.querySelector('.shield').click()");
  check("click on the picture plays (via the shield)", await waitFor(async () => (await st()) === "1", 20000));
  await sleep(1500);
  writeFileSync(`${SHOTS}/2-playing.png`, await portal.screenshot());
  // Inside the embed, right after play (when YouTube shows its overlay):
  // no visible link, related videos or "More videos".
  const VISIBLE_OUT = `[...document.querySelectorAll("a, [class*=RelatedVideos], button[aria-label='More videos'], button[aria-label='Copy link']")]
    .filter(e => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width && r.height && cs.display !== "none" && cs.visibility !== "hidden"; }).length`;
  let visibleOut = null;
  for (const c of embedContexts) {
    const r = await cdp.send("Runtime.evaluate", { expression: VISIBLE_OUT, returnByValue: true, contextId: c.id }, c.session).catch(() => null);
    if (r?.result?.type === "number") visibleOut = (visibleOut || 0) + r.result.value;
  }
  check("embed shows no links or suggestions", visibleOut === 0, `visible: ${visibleOut}, contexts: ${embedContexts.length}`);
  await portal.evaluate("document.querySelector('.shield').click()");
  const pausedShown = await waitFor(() => portal.evaluate(`(document.querySelector(".stage")?.dataset.state === "2") && !document.querySelector(".paused").hidden`), 10000);
  check("pause shows our overlay, not YouTube's", pausedShown);
  writeFileSync(`${SHOTS}/3-paused.png`, await portal.screenshot());
  await portal.evaluate("document.querySelector('.resume').click()");
  check("Resume plays again", await waitFor(async () => (await st()) === "1", 10000));
  await portal.evaluate("document.querySelector('.controls .mute').click()");
  check("our Mute button works", await waitFor(() => portal.evaluate("pacifierPlayer.muted === true && document.querySelector('.controls .mute').textContent === 'Unmute'"), 5000));
  await portal.evaluate("document.querySelector('.controls .cc').click()");
  const t1 = await portal.evaluate("pacifierPlayer.currentTime");
  await portal.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
  check("arrow key skips forward", await waitFor(async () => (await portal.evaluate("pacifierPlayer.currentTime")) >= t1 + 4, 8000));
  writeFileSync(`${SHOTS}/2b-controls.png`, await portal.screenshot());
  // Drag our seek bar to the end.
  await portal.evaluate(`(() => { const s = document.querySelector(".seek"); s.value = "997"; s.dispatchEvent(new Event("input")); s.dispatchEvent(new Event("change")); })()`);
  const backToList = await waitFor(() => portal.evaluate(`!location.hash.includes("watch") && !!document.querySelector(".item")`), 30000);
  check("video end returns to the list", backToList);
  check("finished video is greyed as watched", await portal.evaluate(`document.querySelector(".item")?.classList.contains("watched")`));
  writeFileSync(`${SHOTS}/4-after-watch.png`, await portal.screenshot());

  // --- settings: add a creator by handle, refresh, remove ------------------
  const settings = await openPage(cdp, `chrome-extension://${id}/settings.html`);
  await waitFor(() => settings.evaluate(`document.querySelectorAll("#creators li").length > 0`), 10000);
  const before = await settings.evaluate(`document.querySelectorAll("#creators li").length`);
  await settings.evaluate(`(() => { const f = document.getElementById("add"); f.name.value = "Veritasium"; f.handle.value = "veritasium"; f.requestSubmit(); })()`);
  check("settings: add creator", await waitFor(() => settings.evaluate(`document.querySelectorAll("#creators li").length === ${before + 1}`), 5000));
  writeFileSync(`${SHOTS}/5-settings.png`, await settings.screenshot());
  await portal.evaluate(`document.querySelector(".refresh").click()`);
  await waitFor(() => portal.evaluate(`!document.querySelector(".refresh").disabled`), 180000, 1000);
  const resolved = await settings.evaluate(`chrome.storage.local.get("creators").then(r => r.creators.find(c => c.handle === "@veritasium"))`);
  check("Refresh now resolves the new handle", resolved?.channel_id?.startsWith("UC"), JSON.stringify(resolved));
  await settings.evaluate(`location.reload()`);
  await waitFor(() => settings.evaluate(`document.querySelectorAll("#creators li").length === ${before + 1}`), 10000);
  await settings.evaluate(`[...document.querySelectorAll("#creators li")].at(-1).querySelector("button").click()`);
  check("settings: remove creator", await waitFor(() => settings.evaluate(`document.querySelectorAll("#creators li").length === ${before}`), 5000));

  // --- privacy audit ---------------------------------------------------------
  const all = [...requests.values()].filter(r => r.url);
  const leaks = all.filter(r => (r.cookie || "").includes("FAKE"));
  const leakHosts = [...new Set(leaks.map(r => new URL(r.url).host))];
  check("no planted cookie is ever sent", leaks.length === 0,
        leaks.length ? `${leaks.length} requests leaked, hosts: ${leakHosts.join(", ")}` : `${all.length} requests checked`);
  const ytFetches = all.filter(r => /^https:\/\/www\.youtube\.com\/(feeds|watch|results|channel|@)/.test(r.url) && r.cookie !== undefined);
  const onlyConsent = ytFetches.every(r => r.cookie === "SOCS=CAI");
  check("YouTube fetches carry only the consent flag", ytFetches.length > 0 && onlyConsent,
        `${ytFetches.length} fetches; cookies seen: ${[...new Set(ytFetches.map(r => r.cookie))].join(" | ")}`);
  const blocked = [...new Set(all.filter(r => r.blocked).map(r => new URL(r.url).host + new URL(r.url).pathname.split("/").slice(0, 3).join("/")))];
  console.log("      blocked:", blocked.length ? blocked.join(", ") : "nothing");
  const hosts = {};
  for (const r of all) { const h = new URL(r.url).host; hosts[h] = (hosts[h] || 0) + 1; }
  console.log("      hosts contacted:", JSON.stringify(hosts));
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  check("test ran to completion", false, e.stack);
} finally {
  cdp.close();
  b.proc.kill();
  await sleep(500);
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
