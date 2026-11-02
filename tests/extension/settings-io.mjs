// Export settings to a file, wipe everything, load the file back; and make
// sure hostile files are rejected or cleaned.   tests/extension/vm-run.sh settings-io.mjs
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrave, CDP, openPage, waitFor, sleep } from "./cdp.mjs";

const [brave, extension] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail = "") => {
  results.push(Boolean(ok));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const dl = mkdtempSync(join(tmpdir(), "pacifier-dl-"));
const b = await launchBrave({ brave, extension });
const cdp = await CDP.connect(b.ws);
try {
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dl });
  const page = await openPage(cdp, `chrome-extension://${b.extId}/settings.html`);
  await waitFor(() => page.evaluate(`document.querySelectorAll("#creators li").length > 0`), 10000);
  const stored = () => page.evaluate(`chrome.storage.local.get(["creators", "config"])`);
  const status = () => page.evaluate(`document.getElementById("backup-status").textContent`);

  // Make some settings worth keeping.
  await page.evaluate(`(() => {
    const s = document.querySelector("#creators select"); s.value = "high"; s.dispatchEvent(new Event("change"));
    const f = document.getElementById("options"); f.list_size.value = "7"; f.blocked_keywords.value = "crypto"; f.requestSubmit();
  })()`);
  await waitFor(async () => (await stored()).config?.feed_size === 6, 5000);
  const before = await stored();

  // Export through the real button.
  await page.evaluate(`document.getElementById("export").click()`);
  const file = await waitFor(() => readdirSync(dl).find(f => /^pacifier-settings-\d{4}-\d\d-\d\d\.json$/.test(f)), 10000, 250);
  const exported = file && JSON.parse(readFileSync(join(dl, file), "utf8"));
  check("export downloads a settings file", exported?.app === "pacifier" && exported.creators.length === before.creators.length,
        `${file}; ${exported?.creators?.length} creators`);

  // Wipe, then load it back through the real file picker.
  await page.evaluate(`chrome.storage.local.clear()`);
  await page.evaluate(`location.reload()`);
  await sleep(1500);
  const load = async path => {
    const { root } = await cdp.send("DOM.getDocument", {}, page.sessionId);
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#import" }, page.sessionId);
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [path] }, page.sessionId);
    await sleep(1000);
  };
  await load(join(dl, file));
  const after = await stored();
  check("load restores creators, priorities and options",
        after.creators.length === before.creators.length && after.creators[0].priority === "high" &&
        after.config.feed_size === 6 && after.config.suggestion.blocked_keywords[0] === "crypto", await status());
  check("Settings shows what was loaded",
        await page.evaluate(`document.querySelectorAll("#creators li").length === ${before.creators.length} && document.querySelector("#creators select").value === "high" && document.getElementById("options").list_size.value === "7"`));

  // Hostile files.
  const snap = JSON.stringify(await stored());
  for (const [name, body, expect] of [
    ["invalid JSON", "{ nope", /valid JSON/],
    ["not a Pacifier file", JSON.stringify({ hello: "world" }), /isn't a Pacifier/],
  ]) {
    const p = join(dl, name.replace(/\W+/g, "-") + ".json");
    writeFileSync(p, body);
    await load(p);
    check(`rejects ${name}, settings unchanged`, expect.test(await status()) && JSON.stringify(await stored()) === snap, await status());
  }
  const poison = join(dl, "poison.json");
  writeFileSync(poison, JSON.stringify({ app: "pacifier", version: 1, config: { feed_size: 1e9, auto_refresh_hours: "x" },
    creators: [{ name: `<img src=x onerror="window.__pwned=1">`, priority: { toString: "x" }, channel_id: "UC__proto__" },
               { name: 42 }, null, { name: "Fine", handle: "@fine", priority: "low" }] }));
  await load(poison);
  const p2 = await stored();
  const safe = await page.evaluate(`({ pwned: window.__pwned ?? null, injected: document.querySelectorAll("main img, main script").length })`);
  check("poisoned file is cleaned, nothing runs",
        p2.creators.length === 2 && !p2.creators[0].priority && !p2.creators[0].channel_id && p2.creators[1].priority === "low" &&
        p2.config.feed_size === 9 && p2.config.auto_refresh_hours === 20 && !safe.pwned && safe.injected === 0,
        JSON.stringify({ creators: p2.creators, feed_size: p2.config.feed_size, ...safe }));
} catch (e) {
  check("test ran to completion", false, e.stack);
} finally {
  cdp.close(); b.proc.kill(); await sleep(300);
}
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
