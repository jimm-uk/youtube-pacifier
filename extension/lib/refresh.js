// Rebuild the feed: 9 latest videos from the creator list + 1 suggestion.
// A failed run keeps the previous feed and marks it "refresh failed".

import * as S from "./scoring.js";
import * as yt from "./youtube.js";
import { store, getConfig, getCreators } from "./store.js";

const SHORTS_MAX = 180;          // YouTube Shorts can run up to 3 minutes
const FEATURED_TTL_DAYS = 7;
const MAX_CANDIDATES_PER_SEED = 12;
const MAX_SEEDS = 3;
const SEARCH_MIN_SUBSCRIBERS = 5000;
const SUGGESTION_MAX_AGE_DAYS = 60;
const VIDEO_CACHE_DAYS = 90;
const RUN_DEADLINE_MS = 3 * 60e3;  // a stalled connection must not leave "Refreshing…" up for ever
const LOCK_MINUTES = 4;
const DAY = 86400e3;

const today = () => new Date().toISOString().slice(0, 10);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

class Builder {
  constructor(progress) {
    this.progress = progress || (() => {});
    this.now = Date.now();
    this.log = [];
    this.dropped = [];
    this.feeds = new Map();   // channel_id -> RSS entries
    this.names = new Map();   // channel_id -> display name
    this.eligibleCache = new Map();
  }

  note(msg) { this.log.push(msg); }

  async load() {
    this.cfg = await getConfig();
    this.creators = await getCreators();
    // Null-prototype maps: keys come from YouTube data.
    this.videos = Object.assign(Object.create(null), await store.get("videos", {}));
    this.featured = Object.assign(Object.create(null), await store.get("featured", {}));
    this.suggested = await store.get("suggested", []);
  }

  async resolve() {
    this.progress("Finding channels");
    let changed = false;
    for (const c of this.creators) {
      if (!c.channel_id) {
        try {
          if (c.handle) {
            const r = await yt.resolveHandle(c.handle);
            Object.assign(c, { channel_id: r.channel_id, title: r.title });
          } else {
            const { best, matches } = S.pickChannel(c.name, await yt.searchChannels(c.name.replace(/[.… ]+$/, "")),
                                                    this.cfg.min_subscribers_for_match);
            if (!best) {
              c.dropped = matches.length ? `${matches.length} channels match, none clearly the one` : "no matching channel";
              this.dropped.push({ name: c.name, reason: c.dropped });
              continue;
            }
            Object.assign(c, { channel_id: best.channel_id, title: best.title, handle: best.handle || undefined });
          }
          delete c.dropped;
          changed = true;
        } catch (e) {
          this.dropped.push({ name: c.name, reason: "lookup failed" });
          this.note(`lookup failed ${c.name}: ${e.message}`);
          continue;
        }
      }
      this.names.set(c.channel_id, c.title || c.name);
    }
    // Save resolutions, but don't clobber edits made in Settings meanwhile.
    if (changed) {
      const current = await store.get("creators", this.creators);
      const byKey = new Map(this.creators.map(c => [c.handle || c.name, c]));
      await store.set("creators", current.map(c => c.channel_id ? c : (byKey.get(c.handle || c.name) || c)));
    }
  }

  async fetchFeeds() {
    const ids = [...this.names.keys()];
    let done = 0;
    await pool(ids, 4, async cid => {
      try { this.feeds.set(cid, await yt.channelFeed(cid)); }
      catch (e) { this.note(`feed failed ${this.names.get(cid)}: ${e.message}`); }
      this.progress(`Checking creators ${++done}/${ids.length}`);
    });
    if (!this.feeds.size) throw new Error("no creator feeds could be fetched");
  }

  async info(vid) {
    if (this.videos[vid]) return this.videos[vid];
    const info = await yt.videoInfo(vid);
    if (info.final && info.duration <= SHORTS_MAX) info.short = await yt.isShort(vid);
    if (info.final) this.videos[vid] = { ...info, checked: this.now };
    return info;
  }

  eligible(e) {
    if (!this.eligibleCache.has(e.id)) {
      this.eligibleCache.set(e.id, (async () => {
        if (S.blocked(e, this.cfg.suggestion)) return false;
        try {
          const i = await this.info(e.id);
          return i.final && i.playable && i.embeddable && !i.short &&
                 i.duration >= this.cfg.min_duration_seconds;
        } catch (err) {
          this.note(`video check failed ${e.id}: ${err.message}`);
          return false;
        }
      })());
    }
    return this.eligibleCache.get(e.id);
  }

  async suggestion() {
    const s = this.cfg.suggestion;
    // Same day, same suggestion: re-running must not reshuffle it.
    const t = today();
    const same = [...this.suggested].reverse().find(x => x.date === t && x.item);
    if (same) return same.item;

    const cutoff = this.now - s.cooldown_days * DAY;
    const recent = new Set(this.suggested.filter(x => Date.parse(x.date) > cutoff).map(x => x.channel_id));
    const listed = new Set(this.names.keys());
    const seeds = [...this.feeds.keys()].sort();
    const start = Math.floor(this.now / DAY) % seeds.length;   // a different creator each day
    for (let k = 0; k < Math.min(MAX_SEEDS, seeds.length); k++) {
      const seed = seeds[(start + k) % seeds.length];
      this.progress(`Looking for a suggestion (${this.names.get(seed)})`);
      const item = await this.suggestFrom(seed, new Set([...listed, ...recent]), s);
      if (item) {
        this.suggested.push({ date: t, channel_id: item.channel_id, channel: item.channel, item });
        await store.set("suggested", this.suggested.slice(-200));
        return item;
      }
    }
    this.note("no suggestion passed the bar today");
    return null;
  }

  async suggestFrom(seed, exclude, s) {
    const kws = S.keywords(this.feeds.get(seed).map(v => v.title), 10);
    let cands = [...await this.featuredOf(seed)];
    if (kws.length) {
      try {
        for (const r of await yt.searchChannels(kws.slice(0, 2).join(" ")))
          if (r.subscribers >= SEARCH_MIN_SUBSCRIBERS) cands.push(r.channel_id);
      } catch (e) { this.note(`search failed: ${e.message}`); }
    }
    cands = [...new Set(cands)].filter(c => !exclude.has(c)).slice(0, MAX_CANDIDATES_PER_SEED);

    const scored = [];
    const listedNames = [...this.names.values()];
    await pool(cands, 4, async cid => {
      let feed;
      try { feed = await yt.channelFeed(cid); } catch { return; }
      if (!feed.length) return;
      const name = feed[0].channel;
      if (S.blocked({ channel_id: cid, channel: name }, s)) return;
      if (S.spinOff(name, listedNames)) { this.note(`candidate ${name}: spin-off`); return; }
      const a = S.assessCandidate(feed, this.now, s, kws);
      if (a.score == null) { this.note(`candidate ${name}: ${a.why}`); return; }
      scored.push({ ...a, cid, feed });
    });
    scored.sort((x, y) => y.score - x.score);

    for (const c of scored) {
      const fresh = c.feed.slice(0, 5).filter(v => this.now - Date.parse(v.published) <= SUGGESTION_MAX_AGE_DAYS * DAY);
      for (const v of fresh) {
        if (S.clickbaitScore(v.title) < 1 && S.nonLatinShare([v.title]) < 0.1 && await this.eligible(v)) {
          return this.item(v, "suggestion", `Similar to ${this.names.get(seed)} · uploads ${c.cadence}`);
        }
      }
    }
    return null;
  }

  async featuredOf(cid) {
    const f = this.featured[cid];
    if (f && this.now - Date.parse(f.at) < FEATURED_TTL_DAYS * DAY) return f.ids;
    const ids = await yt.featuredChannels(cid);
    this.featured[cid] = { ids, at: today() };
    return ids;
  }

  item(e, kind, reason) {
    return {
      id: e.id, title: e.title,
      channel: this.names.get(e.channel_id) || e.channel,
      channel_id: e.channel_id, published: e.published,
      duration: this.videos[e.id]?.duration ?? null,
      kind, ...(reason ? { reason } : {}),
    };
  }

  async build() {
    await this.load();
    await this.resolve();
    await this.fetchFeeds();
    const entries = [...this.feeds.values()].flat();
    const { feed_size: size, max_per_creator: cap } = this.cfg;

    this.progress("Checking videos");
    const level = p => (p === "high" || p === "low" ? p : "normal");
    const priority = new Map(this.creators.filter(c => c.channel_id).map(c => [c.channel_id, level(c.priority)]));
    const opts = { priorityOf: id => priority.get(id), now: this.now };
    let items = (await S.selectFeed(entries, size, cap, e => this.eligible(e), opts)).map(e => this.item(e, "list"));
    const sugg = this.cfg.suggestions ? await this.suggestion() : null;
    if (sugg) items.push(sugg);
    else {
      // No suggestion worth showing: the 10th slot goes to the list instead.
      items = (await S.selectFeed(entries, size + 1, cap, e => this.eligible(e), opts)).map(e => this.item(e, "list"));
    }

    // Keep the caches small: forget video checks older than 90 days.
    for (const [id, v] of Object.entries(this.videos)) if (this.now - (v.checked || 0) > VIDEO_CACHE_DAYS * DAY) delete this.videos[id];
    await store.set("videos", this.videos);
    await store.set("featured", this.featured);
    return { status: "ok", updated_at: new Date(this.now).toISOString(), items, dropped: this.dropped, log: this.log };
  }
}

// Run a refresh unless one is already running (e.g. in another tab).
export async function refresh(progress) {
  const lock = await store.get("running");
  if (lock && Date.now() - lock < LOCK_MINUTES * 60e3) return { skipped: true };
  await store.set("running", Date.now());
  let stage = "starting";   // recorded on failure, to show where a stall happened
  const track = msg => { stage = msg; progress?.(msg); };
  try {
    const feed = await Promise.race([
      new Builder(track).build(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("refresh took longer than 3 minutes")), RUN_DEADLINE_MS)),
    ]);
    await store.set("feed", feed);
    return feed;
  } catch (e) {
    const prev = await store.get("feed", { items: [], dropped: [] });
    const failed = { ...prev, status: "failed", failed_at: new Date().toISOString(), error: String(e.message || e), stage };
    await store.set("feed", failed);
    return failed;
  } finally {
    await chrome.storage.local.remove("running");
  }
}
