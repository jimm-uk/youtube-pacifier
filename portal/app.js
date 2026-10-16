// Pacifier portal: one list, one player, nothing else.
"use strict";

const app = document.getElementById("app");
const WATCHED_KEY = "pacifier.watched";
const WATCHED_AT = 0.9; // fraction played that counts as watched

let feed = null;
let player = null;
let progressTimer = null;

// --- watched state (browser only; losing it just un-greys items) -----------

function readWatched() {
  try { return JSON.parse(localStorage.getItem(WATCHED_KEY)) || {}; }
  catch { return {}; }
}
function setWatched(id, on) {
  const w = readWatched();
  if (on) w[id] = Date.now(); else delete w[id];
  // Forget anything no longer on the page.
  if (feed) for (const k of Object.keys(w)) if (!feed.items.some(i => i.id === k)) delete w[k];
  try { localStorage.setItem(WATCHED_KEY, JSON.stringify(w)); } catch { /* private mode */ }
}
const isWatched = id => Boolean(readWatched()[id]);

// --- formatting -------------------------------------------------------------

const dateFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

function fmtDuration(s) {
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${Math.max(1, m)} min`;
}
function meta(item) {
  return [item.channel, dateFmt.format(new Date(item.published)), fmtDuration(item.duration)]
    .filter(Boolean).join(" · ");
}
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v; else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

// --- list -------------------------------------------------------------------

function itemRow(item) {
  const watched = isWatched(item.id);
  return el("li", { class: "item" + (watched ? " watched" : "") },
    el("a", { href: `#watch/${item.id}` },
      el("span", { class: "title" }, item.title),
      el("span", { class: "meta" }, meta(item) + (watched ? " · watched" : ""))));
}

function renderList() {
  stopPlayer();
  document.title = "Pacifier";
  const updated = new Date(feed.updated_at);
  const status = feed.status === "failed"
    ? el("p", { class: "status warn" },
        `Refresh failed at ${timeFmt.format(new Date(feed.failed_at))} — showing the list from ${dateFmt.format(updated)}.`)
    : el("p", { class: "status" },
        `Updated ${dateFmt.format(updated)}, ${timeFmt.format(updated)} · next at ${feed.refresh}`);

  const list = feed.items.filter(i => i.kind === "list");
  const sugg = feed.items.filter(i => i.kind === "suggestion");

  const parts = [
    el("header", {}, el("h1", {}, "Pacifier"), status),
    el("ol", { class: "items" }, ...list.map(itemRow)),
  ];
  if (sugg.length) {
    parts.push(el("section", { class: "suggestion" },
      el("h2", {}, "Suggestion — not on your list"),
      el("ol", { class: "items" }, ...sugg.map(i => {
        const row = itemRow(i);
        if (i.reason) row.querySelector("a").append(el("span", { class: "reason" }, i.reason));
        return row;
      }))));
  }
  const foot = [el("p", {}, `That's everything. Next update at ${feed.refresh}.`)];
  if (feed.dropped && feed.dropped.length) {
    foot.push(el("p", { class: "dropped" },
      "Not included: " + feed.dropped.map(d => `${d.name} (${d.reason})`).join("; ") + "."));
  }
  parts.push(el("footer", {}, ...foot));
  app.replaceChildren(...parts);
}

// --- player -----------------------------------------------------------------

let ytReady = null;
function loadYouTubeApi() {
  if (!ytReady) {
    ytReady = new Promise(resolve => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
      document.head.append(el("script", { src: "https://www.youtube.com/iframe_api" }));
    });
  }
  return ytReady;
}

function stopPlayer() {
  clearInterval(progressTimer);
  progressTimer = null;
  if (player) { try { player.destroy(); } catch { /* already gone */ } player = null; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

async function renderPlayer(id) {
  const item = feed.items.find(i => i.id === id);
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
  const fsButton = app.querySelector(".fullscreen");

  const showToggle = () => { toggle.textContent = isWatched(id) ? "Mark as not watched" : "Mark as watched"; };
  showToggle();
  toggle.onclick = () => { setWatched(id, !isWatched(id)); showToggle(); };

  fsButton.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen().catch(() => {});
  };

  const playPause = () => {
    if (!player || !player.getPlayerState) return;
    const s = player.getPlayerState();
    if (s === YT.PlayerState.PLAYING || s === YT.PlayerState.BUFFERING) player.pauseVideo();
    else player.playVideo();
  };
  shield.onclick = playPause;
  shield.onkeydown = e => { if (e.key === " " || e.key === "k" || e.key === "Enter") { e.preventDefault(); playPause(); } };
  app.querySelector(".resume").onclick = () => player && player.playVideo();

  const YTApi = await loadYouTubeApi();
  if (!document.getElementById("player")) return; // navigated away while loading

  player = new YTApi.Player("player", {
    host: "https://www.youtube-nocookie.com",
    videoId: id,
    playerVars: {
      autoplay: 0, rel: 0, iv_load_policy: 3, fs: 0, playsinline: 1,
      cc_load_policy: 0, origin: location.origin,
    },
    events: {
      onStateChange: e => {
        const S = YTApi.PlayerState;
        paused.hidden = e.data !== S.PAUSED;
        if (e.data === S.PLAYING && !progressTimer) {
          progressTimer = setInterval(() => {
            const d = player && player.getDuration(), t = player && player.getCurrentTime();
            if (d && t / d >= WATCHED_AT && !isWatched(id)) { setWatched(id, true); showToggle(); }
          }, 5000);
        }
        if (e.data === S.ENDED) {
          // Leave before YouTube's end screen can offer anything else.
          setWatched(id, true);
          location.hash = "";
        }
      },
    },
  });
}

// --- routing ----------------------------------------------------------------

function route() {
  if (!feed) return;
  const m = location.hash.match(/^#watch\/([\w-]{11})$/);
  if (m) renderPlayer(m[1]); else renderList();
}

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !document.fullscreenElement && location.hash) location.hash = "";
});
window.addEventListener("hashchange", route);

fetch("/feed.json", { cache: "no-store" })
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(data => { feed = data; route(); })
  .catch(() => {
    app.replaceChildren(el("header", {}, el("h1", {}, "Pacifier"),
      el("p", { class: "status warn" }, "No list yet — the first fetch hasn't run.")));
  });
