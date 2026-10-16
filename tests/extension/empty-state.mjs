// A fresh install without creators.local.js starts empty and says so,
// rather than attempting (and failing) a refresh.
//   tests/extension/vm-run.sh empty-state.mjs
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrave, CDP, openPage, waitFor, sleep } from "./cdp.mjs";

const [brave, extension] = process.argv.slice(2);
const copy = join(mkdtempSync(join(tmpdir(), "pacifier-empty-")), "extension");
cpSync(extension, copy, { recursive: true });
rmSync(join(copy, "creators.local.js"), { force: true });

const b = await launchBrave({ brave, extension: copy });
const cdp = await CDP.connect(b.ws);
let ok = false;
try {
  const page = await openPage(cdp, `chrome-extension://${b.extId}/portal.html`);
  const shown = await waitFor(() => page.evaluate(`/No creators yet/.test(document.querySelector(".status")?.textContent || "")`), 15000);
  await sleep(3000);
  const state = await page.evaluate(`(async () => ({
    status: document.querySelector(".status")?.textContent,
    creators: (await chrome.storage.local.get("creators")).creators,
    feed: (await chrome.storage.local.get("feed")).feed ?? null,
    settingsLink: !!document.querySelector(".status a[href='settings.html']"),
  }))()`);
  ok = shown && Array.isArray(state.creators) && state.creators.length === 0 && state.feed === null && state.settingsLink;
  console.log(`${ok ? "PASS" : "FAIL"}  fresh install without a seed list shows the empty state, no refresh attempted — ${JSON.stringify(state)}`);
} catch (e) {
  console.log("FAIL  test ran to completion —", e.message);
} finally {
  cdp.close(); b.proc.kill(); await sleep(300);
}
process.exit(ok ? 0 : 1);
