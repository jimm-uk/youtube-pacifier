// Pacifier portal: one list, one player, nothing else.
import { protectThisTab, releaseTab } from "./lib/net.js";
import { EmbedPlayer, State } from "./lib/player.js";
import { refresh } from "./lib/refresh.js";
import { store, getConfig, getCreators, getWatched, setWatched } from "./lib/store.js";

const app = document.getElementById("app");
const WATCHED_AT = 0.9; // fraction played that counts as watched

let feed = null;
let watched = {};
let player = null;
let refreshing = null;   // progress text while a refresh runs
let keyHandler = null;   // player keyboard shortcuts, only while watching
let noCreators = false;  // fresh install without a seed list

// --- formatting -------------------------------------------------------------

const dateFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

function fmtDuration(s) {
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${Math.max(1, m)} min`;
}
const meta = item => [item.channel, dateFmt.format(new Date(item.published)), fmtDuration(item.duration)]
  .filter(Boolean).join(" · ");

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

// --- list -------------------------------------------------------------------

function itemRow(item) {
  const w = Boolean(watched[item.id]);
  const a = el("a", { href: `#watch/${item.id}` },
    el("span", { class: "title" }, item.title),
    el("span", { class: "meta" }, meta(item) + (w ? " · watched" : "")));
  if (item.reason) a.append(el("span", { class: "reason" }, item.reason));
  return el("li", { class: "item" + (w ? " watched" : "") }, a);
}

function statusLine() {
  if (refreshing) return el("p", { class: "status" }, refreshing + "…");
  if (noCreators) return el("p", { class: "status" }, "No creators yet — add some in ",
                            el("a", { href: "settings.html" }, "Settings"), ".");
  if (!feed) return el("p", { class: "status" }, "No list yet.");
  const updated = new Date(feed.updated_at);
  if (feed.status === "failed") {
    return el("p", { class: "status warn" },
      `Refresh failed at ${timeFmt.format(new Date(feed.failed_at))}` +
      (feed.updated_at ? ` — showing the list from ${dateFmt.format(updated)}.` : "."));
  }
  return el("p", { class: "status" }, `Updated ${dateFmt.format(updated)}, ${timeFmt.format(updated)}`);
}

function renderList() {
  stopPlayer();
  document.title = "Pacifier";
  const items = feed?.items || [];
  const list = items.filter(i => i.kind === "list");
  const sugg = items.filter(i => i.kind === "suggestion");

  const header = el("header", {},
    el("div", { class: "head-row" },
      el("h1", {}, "Pacifier"),
      el("button", { type: "button", class: "refresh", onclick: runRefresh,
                     ...(refreshing ? { disabled: "" } : {}) }, "Refresh now")),
    statusLine());
  const parts = [header];
  if (list.length) parts.push(el("ol", { class: "items" }, ...list.map(itemRow)));
  if (sugg.length) {
    parts.push(el("section", { class: "suggestion" },
      el("h2", {}, "Suggestion — not on your list"),
      el("ol", { class: "items" }, ...sugg.map(itemRow))));
  }
  const foot = [];
  if (items.length) foot.push(el("p", {}, "That's everything."));
  if (feed?.dropped?.length) {
    foot.push(el("p", { class: "dropped" },
      "Not included: " + feed.dropped.map(d => `${d.name} (${d.reason})`).join("; ") + "."));
  }
  foot.push(el("p", {}, el("a", { href: "settings.html", class: "quiet" }, "Settings")));
  parts.push(el("footer", {}, ...foot));
  app.replaceChildren(...parts);
}

async function runRefresh() {
  if (refreshing) return;
  noCreators = (await getCreators()).length === 0;
  if (noCreators) { if (!location.hash) renderList(); return; }
  refreshing = "Starting";
  if (!location.hash) renderList();
  await protectThisTab();   // re-assert: a reload's pagehide may have released this tab
  const result = await refresh(msg => {
    refreshing = msg;
    if (!location.hash) app.querySelector(".status")?.replaceWith(statusLine());
  });
  refreshing = null;
  if (!result.skipped) feed = result;
  if (!location.hash) renderList();
}

// --- player -----------------------------------------------------------------

function stopPlayer() {
  keyHandler = null;
  if (player) { player.destroy(); player = null; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

async function renderPlayer(id) {
  await protectThisTab();   // the embed needs its Referer rule
  const item = feed?.items.find(i => i.id === id);
  if (!item) { location.hash = ""; return; }
  stopPlayer();
  document.title = item.title;

  const view = document.getElementById("player-view").content.cloneNode(true);
  view.querySelector(".watch-title").textContent = item.title;
  view.querySelector(".watch-meta").textContent = meta(item);
  app.replaceChildren(view);

  const stage = app.querySelector(".stage");
  const paused = app.querySelector(".paused");
  const shield = app.querySelector(".shield");
  const toggle = app.querySelector(".toggle-watched");
  const pp = app.querySelector(".pp"), seek = app.querySelector(".seek");
  const time = app.querySelector(".time"), dur = app.querySelector(".dur");
  const muteBtn = app.querySelector(".mute"), cc = app.querySelector(".cc");

  const mark = async on => { await setWatched(id, on); watched = await getWatched(); showToggle(); };
  const showToggle = () => { toggle.textContent = watched[id] ? "Mark as not watched" : "Mark as watched"; };
  showToggle();
  toggle.onclick = () => mark(!watched[id]);

  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen().catch(() => {});
  };
  app.querySelector(".fullscreen").onclick = fullscreen;

  const playing = () => player && (player.state === State.PLAYING || player.state === State.BUFFERING);
  const playPause = () => { if (!player) return; playing() ? player.pause() : player.play(); };
  const skip = secs => { if (player?.duration) player.seekTo(Math.max(0, Math.min(player.duration - 1, player.currentTime + secs))); };
  const toggleMute = () => { if (!player) return; player.muted ? player.unMute() : player.mute(); showMute(); };
  const showMute = () => { muteBtn.textContent = player?.muted ? "Unmute" : "Mute"; };
  const toggleCc = () => {
    const on = cc.getAttribute("aria-pressed") !== "true";
    player?.captions(on);
    cc.setAttribute("aria-pressed", String(on));
  };

  shield.onclick = playPause;
  pp.onclick = playPause;
  muteBtn.onclick = toggleMute;
  cc.onclick = toggleCc;
  app.querySelector(".resume").onclick = () => player?.play();

  // Keyboard, while the player view is open (not when typing in a field).
  keyHandler = e => {
    if (e.target.closest?.("input, textarea") && e.target !== seek) return;
    if (e.target.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return; // the button handles it
    const keys = { " ": playPause, k: playPause, ArrowLeft: () => skip(-5), ArrowRight: () => skip(5),
                   m: toggleMute, c: toggleCc, f: fullscreen };
    const fn = keys[e.key];
    if (fn && !(e.target === seek && e.key.startsWith("Arrow"))) { e.preventDefault(); fn(); }
  };

  let dragging = false;
  seek.addEventListener("input", () => {
    dragging = true;
    if (player?.duration) time.textContent = clock(seek.value / 1000 * player.duration);
  });
  seek.addEventListener("change", () => {
    dragging = false;
    if (player?.duration) player.seekTo(seek.value / 1000 * player.duration);
  });

  player = new EmbedPlayer(stage.querySelector(".frame"), id, {
    onState: s => {
      stage.dataset.state = s;   // also lets tests see the player state
      paused.hidden = s !== State.PAUSED;
      pp.textContent = s === State.PLAYING || s === State.BUFFERING ? "Pause" : "Play";
      if (s === State.ENDED) {
        // Leave before YouTube's end screen can offer anything else.
        mark(true).then(() => { location.hash = ""; });
      }
    },
    onProgress: (t, d) => {
      if (d) {
        dur.textContent = clock(d);
        if (!dragging) { time.textContent = clock(t); seek.value = String(Math.round(t / d * 1000)); }
      }
      showMute();
      if (d && t / d >= WATCHED_AT && !watched[id]) mark(true);
    },
  });
  window.pacifierPlayer = player;   // for debugging from the console, and for tests
}

function clock(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// --- routing ----------------------------------------------------------------

function route() {
  const m = location.hash.match(/^#watch\/([\w-]{11})$/);
  if (m) renderPlayer(m[1]); else renderList();
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !document.fullscreenElement && location.hash) { location.hash = ""; return; }
  keyHandler?.(e);
});
window.addEventListener("hashchange", route);

// Another Pacifier tab refreshed: pick up its list.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.feed) { feed = changes.feed.newValue; if (!location.hash && !refreshing) renderList(); }
  if (changes.watched) watched = changes.watched.newValue || {};
});

// Navigating this tab away from Pacifier: take it out of the network rules.
// (The background worker also cleans up when the tab is closed.)
let myTabId = null;
window.addEventListener("pagehide", () => { if (myTabId != null) releaseTab(myTabId); });

(async () => {
  myTabId = (await chrome.tabs.getCurrent()).id;
  await protectThisTab();
  [feed, watched] = await Promise.all([store.get("feed", null), getWatched()]);
  noCreators = (await getCreators()).length === 0;
  route();
  if (noCreators) return;
  const { auto_refresh_hours: hours } = await getConfig();
  const age = feed?.updated_at ? Date.now() - Date.parse(feed.updated_at) : Infinity;
  if (hours > 0 && age > hours * 3600e3) runRefresh();
})();
