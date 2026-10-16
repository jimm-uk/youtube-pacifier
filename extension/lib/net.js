// Network rules for Pacifier's own tab only (session rules scoped by tabId),
// so nothing here touches YouTube anywhere else in the browser.
//
// - No cookies: our own fetches use credentials: "omit", and the player
//   iframe is credentialless (player.js). On top of that, youtube.com
//   requests from this tab carry only YouTube's "reject all" consent flag
//   (SOCS=CAI), which identifies nobody and stops youtube.com redirecting
//   our fetches to the consent page.
// - Ads and tracking: the same request-blocking approach Brave Shields and
//   uBlock Origin use, with the YouTube rules from their public filter lists.
// - Referer: YouTube's embed refuses to play without an http(s) referrer
//   (error 153), and extension pages don't send one.

const RULE_BASE = 9000;
const BLOCK_DOMAINS = ["doubleclick.net", "googlesyndication.com", "googleadservices.com",
                       "google-analytics.com", "googletagmanager.com", "googletagservices.com",
                       "imasdk.googleapis.com",
                       // Web anti-abuse attestation: heavy browser fingerprinting.
                       "jnn-pa.googleapis.com"];
const BLOCK_PATHS = [
  "||youtube.com/api/stats/ads", "||youtube-nocookie.com/api/stats/ads",
  "||youtube.com/pagead/", "||youtube-nocookie.com/pagead/",
  "||youtube.com/ptracking", "||youtube-nocookie.com/ptracking",
  "||youtube.com/api/stats/atr", "||youtube-nocookie.com/api/stats/atr",
  "||youtube.com/get_midroll_", "||youtube-nocookie.com/get_midroll_",
  "||youtube.com/youtubei/v1/log_event", "||youtube-nocookie.com/youtubei/v1/log_event",
  "||play.google.com/log",
  "||google.com/js/th/",        // BotGuard fingerprinting script
];
export const EMBED_REFERER = "https://www.youtube-nocookie.com/";

// Never main_frame: if the Pacifier tab is navigated to a website, that
// navigation is the user's, not ours.
const SUB = ["sub_frame", "stylesheet", "script", "image", "font", "object",
             "xmlhttprequest", "ping", "media", "websocket", "other"];

// Every rule needs both: the request comes from a Pacifier tab AND was
// started by Pacifier itself (extId) or by the YouTube embed inside it.
// So a website loaded in that tab later is never affected.
export function buildRules(tabIds, extId, referer = EMBED_REFERER) {
  let id = RULE_BASE;
  const ours = [extId];
  const oursOrEmbed = [extId, "youtube-nocookie.com"];
  const rules = [
    {
      id: id++, priority: 2,
      condition: { tabIds, initiatorDomains: ours, requestDomains: ["youtube.com"], resourceTypes: ["xmlhttprequest"] },
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "cookie", operation: "set", value: "SOCS=CAI" },
                         { header: "accept-language", operation: "set", value: "en-GB,en;q=0.8" }],
        responseHeaders: [{ header: "set-cookie", operation: "remove" }],
      },
    },
    {
      id: id++, priority: 3,
      condition: { tabIds, initiatorDomains: ours, requestDomains: ["www.youtube-nocookie.com"], resourceTypes: ["sub_frame"] },
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "referer", operation: "set", value: referer },
                         { header: "cookie", operation: "remove" }],
        responseHeaders: [{ header: "set-cookie", operation: "remove" }],
      },
    },
    {
      id: id++, priority: 4,
      condition: { tabIds, initiatorDomains: oursOrEmbed, requestDomains: BLOCK_DOMAINS, resourceTypes: SUB },
      action: { type: "block" },
    },
  ];
  for (const urlFilter of BLOCK_PATHS) {
    rules.push({ id: id++, priority: 4, condition: { tabIds, initiatorDomains: oursOrEmbed, urlFilter, resourceTypes: SUB },
                 action: { type: "block" } });
  }
  return rules;
}

async function setTabs(update) {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const prior = existing.find(r => r.id === RULE_BASE)?.condition.tabIds ?? [];
  const alive = [];
  for (const t of prior) {
    try { await chrome.tabs.get(t); alive.push(t); } catch { /* tab closed */ }
  }
  const tabIds = update(alive);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.filter(r => r.id >= RULE_BASE).map(r => r.id),
    addRules: tabIds.length ? buildRules(tabIds, chrome.runtime.id) : [],
  });
  return tabIds;
}

// Apply the rules to this tab, keeping any other open Pacifier tabs covered.
export async function protectThisTab() {
  const me = (await chrome.tabs.getCurrent()).id;
  return setTabs(alive => [...new Set([...alive, me])]);
}

// Leaving the portal (closed, or navigated elsewhere): stop covering this tab.
export async function releaseTab(tabId) {
  return setTabs(alive => alive.filter(t => t !== tabId));
}
