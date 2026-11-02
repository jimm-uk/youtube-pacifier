// Screenshot the bottom of Settings (debug aid).  tests/extension/vm-run.sh shot-settings.mjs
import { writeFileSync } from "node:fs";
import { launchBrave, CDP, openPage, sleep } from "./cdp.mjs";
const [brave, extension] = process.argv.slice(2);
const b = await launchBrave({ brave, extension });
const cdp = await CDP.connect(b.ws);
const p = await openPage(cdp, `chrome-extension://${b.extId}/settings.html`);
await sleep(1500);
await p.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
await sleep(300);
writeFileSync("/tmp/pacifier-shots/settings-bottom.png", await p.screenshot());
cdp.close(); b.proc.kill(); await sleep(300);
