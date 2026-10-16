import { releaseTab } from "./lib/net.js";

// Toolbar button: open Pacifier, or bring an already-open Pacifier tab forward.
const PORTAL = chrome.runtime.getURL("portal.html");

chrome.action.onClicked.addListener(async () => {
  const [ctx] = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [PORTAL] });
  if (ctx && ctx.tabId >= 0) {
    await chrome.tabs.update(ctx.tabId, { active: true });
    if (ctx.windowId >= 0) await chrome.windows.update(ctx.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: PORTAL });
  }
});

// A closed Pacifier tab drops out of the network rules.
chrome.tabs.onRemoved.addListener(tabId => { releaseTab(tabId).catch(() => {}); });
