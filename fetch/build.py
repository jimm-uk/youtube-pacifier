"""Rebuild data/feed.json: 9 latest videos from creators.toml + 1 suggestion.

Run: python3 fetch/build.py
A failed run keeps the previous feed and marks it 'refresh failed'."""

import json
import os
import signal
import sys
import tomllib
import traceback
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scoring  # noqa: E402
import youtube as yt  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "cache"
FEED = DATA / "feed.json"
SUGGESTED = DATA / "suggested.json"
LOG = DATA / "logs" / "fetch.log"

SHORTS_MAX = 180          # YouTube Shorts can run up to 3 minutes
FEATURED_TTL_DAYS = 7
MAX_CANDIDATES_PER_SEED = 12
MAX_SEEDS = 3
SEARCH_MIN_SUBSCRIBERS = 5000
SUGGESTION_MAX_AGE_DAYS = 60   # the suggestion must be new material too
RUN_TIMEOUT_SECONDS = 600


def log(msg):
    line = f"{datetime.now().isoformat(timespec='seconds')} {msg}"
    print(line)
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(line + "\n")


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False))
    os.replace(tmp, path)


class Builder:
    def __init__(self):
        self.cfg = tomllib.loads((ROOT / "config.toml").read_text())
        path = ROOT / "creators.toml"
        if not path.exists():
            raise RuntimeError("no creators.toml — copy creators.example.toml and edit it")
        self.creators = tomllib.loads(path.read_text()).get("creator", [])
        self.channels = load_json(CACHE / "channels.json", {})
        self.videos = load_json(CACHE / "videos.json", {})
        self.featured = load_json(CACHE / "featured.json", {})
        self.suggested = load_json(SUGGESTED, [])
        self.now = datetime.now(timezone.utc)
        self.dropped = []
        self.feeds = {}          # channel_id -> RSS entries
        self.names = {}          # channel_id -> display name
        self._eligible = {}      # video_id -> bool, this run

    # --- creators ----------------------------------------------------------

    def resolve(self):
        min_subs = self.cfg["min_subscribers_for_match"]
        for c in self.creators:
            name, handle = c["name"], c.get("handle")
            key = handle or name
            if key in self.channels:
                ch = self.channels[key]
            else:
                try:
                    if handle:
                        ch = yt.resolve_handle(handle)
                    else:
                        results = yt.search_channels(name.rstrip(".… "))
                        best, matches = scoring.pick_channel(name, results, min_subs)
                        if not best:
                            why = ("no matching channel" if not matches else
                                   f"{len(matches)} channels match, none clearly the one")
                            self.dropped.append({"name": name, "reason": why})
                            log(f"dropped {name!r}: {why}")
                            continue
                        ch = {"channel_id": best["channel_id"], "title": best["title"],
                              "handle": best["handle"], "subscribers": best["subscribers"]}
                except yt.YouTubeError as e:
                    self.dropped.append({"name": name, "reason": "lookup failed"})
                    log(f"lookup failed {name!r}: {e}")
                    continue
                ch["resolved_at"] = date.today().isoformat()
                self.channels[key] = ch
                log(f"resolved {name!r} -> {ch['title']} {ch['channel_id']}")
            self.names[ch["channel_id"]] = ch["title"]
        save_json(CACHE / "channels.json", self.channels)

    def fetch_feeds(self):
        for cid, title in self.names.items():
            try:
                self.feeds[cid] = yt.channel_feed(cid)
            except Exception as e:  # one bad feed must not sink the rest
                log(f"feed failed {title}: {e}")
        if not self.feeds:
            raise RuntimeError("no creator feeds could be fetched")

    # --- eligibility -------------------------------------------------------

    def info(self, vid):
        if vid in self.videos:
            return self.videos[vid]
        info = yt.video_info(vid)
        if info["final"] and info["duration"] <= SHORTS_MAX:
            info["short"] = yt.is_short(vid)
        if info["final"]:
            self.videos[vid] = info
        return info

    def eligible(self, e):
        vid = e["id"]
        if vid not in self._eligible:
            ok = False
            if not scoring.blocked(e, self.cfg["suggestion"]):
                try:
                    i = self.info(vid)
                    ok = (i["final"] and i["playable"] and i["embeddable"]
                          and i["duration"] >= self.cfg["min_duration_seconds"]
                          and not i.get("short"))
                except yt.YouTubeError as err:
                    log(f"video check failed {vid}: {err}")
            self._eligible[vid] = ok
        return self._eligible[vid]

    # --- suggestion --------------------------------------------------------

    def suggestion(self):
        s = self.cfg["suggestion"]
        cooldown = self.now.date() - timedelta(days=s["cooldown_days"])
        recent = {x["channel_id"] for x in self.suggested
                  if date.fromisoformat(x["date"]) > cooldown}

        # Same day, same suggestion: re-running the fetch must not reshuffle it.
        today = self.now.date().isoformat()
        for x in reversed(self.suggested):
            if x["date"] == today and x.get("item"):
                return x["item"]

        listed = set(self.names)
        seeds = sorted(self.feeds)
        if not seeds:
            return None
        start = self.now.date().toordinal() % len(seeds)  # a different creator each day
        for k in range(min(MAX_SEEDS, len(seeds))):
            seed = seeds[(start + k) % len(seeds)]
            item = self._suggest_from(seed, listed | recent, s)
            if item:
                self.suggested.append({"date": today, "channel_id": item["channel_id"],
                                       "channel": item["channel"], "item": item})
                save_json(SUGGESTED, self.suggested[-200:])
                return item
        log("no suggestion passed the bar today")
        return None

    def _suggest_from(self, seed, exclude, s):
        seed_titles = [v["title"] for v in self.feeds[seed]]
        kws = scoring.keywords(seed_titles, 10)
        cands = list(self._featured(seed))
        if kws:
            try:
                for r in yt.search_channels(" ".join(kws[:2])):
                    if r["subscribers"] >= SEARCH_MIN_SUBSCRIBERS:
                        cands.append(r["channel_id"])
            except yt.YouTubeError as e:
                log(f"search failed: {e}")
        cands = [c for c in dict.fromkeys(cands) if c not in exclude][:MAX_CANDIDATES_PER_SEED]

        scored = []
        for cid in cands:
            try:
                feed = yt.channel_feed(cid)
            except yt.YouTubeError:
                continue
            if not feed or scoring.blocked({"channel_id": cid, "channel": feed[0]["channel"]}, s):
                continue
            if scoring.spin_off(feed[0]["channel"], self.names.values()):
                log(f"  candidate {feed[0]['channel']}: rejected (spin-off channel)")
                continue
            score, detail = scoring.assess_candidate(feed, self.now, s, kws)
            if score is None:
                log(f"  candidate {feed[0]['channel']}: rejected ({detail})")
                continue
            scored.append((score, cid, feed, detail))
        scored.sort(key=lambda x: x[0], reverse=True)

        for score, cid, feed, detail in scored:
            fresh = [v for v in feed[:5]
                     if self.now - yt.parse_time(v["published"]) <= timedelta(days=SUGGESTION_MAX_AGE_DAYS)]
            for v in fresh:
                if scoring.clickbait_score(v["title"]) < 1.0 and self.eligible(v):
                    reason = f"Similar to {self.names[seed]} · uploads {detail['cadence']}"
                    log(f"suggestion: {v['channel']} — {v['title']} ({reason}, score {score})")
                    return self._item(v, "suggestion", reason)
        return None

    def _featured(self, cid):
        f = self.featured.get(cid)
        fresh = f and date.fromisoformat(f["at"]) > self.now.date() - timedelta(days=FEATURED_TTL_DAYS)
        if not fresh:
            f = {"ids": yt.featured_channels(cid), "at": self.now.date().isoformat()}
            self.featured[cid] = f
            save_json(CACHE / "featured.json", self.featured)
        return f["ids"]

    # --- output ------------------------------------------------------------

    def _item(self, e, kind, reason=None):
        item = {
            "id": e["id"],
            "title": e["title"],
            "channel": self.names.get(e["channel_id"], e["channel"]),
            "channel_id": e["channel_id"],
            "published": e["published"],
            "duration": self.videos.get(e["id"], {}).get("duration"),
            "kind": kind,
        }
        if reason:
            item["reason"] = reason
        return item

    def build(self):
        self.resolve()
        self.fetch_feeds()
        entries = [e for f in self.feeds.values() for e in f]
        size, cap = self.cfg["feed_size"], self.cfg["max_per_creator"]

        picked = scoring.select_feed(entries, size, cap, self.eligible)
        items = [self._item(e, "list") for e in picked]
        sugg = self.suggestion() if self.cfg["suggestions"] else None
        if sugg:
            items.append(sugg)
        else:
            # No suggestion worth showing: the 10th slot goes to the list instead.
            extra = scoring.select_feed(entries, size + 1, cap, self.eligible)
            items = [self._item(e, "list") for e in extra]

        save_json(CACHE / "videos.json", self.videos)
        return {
            "status": "ok",
            "updated_at": self.now.isoformat(timespec="seconds"),
            "refresh": self.cfg["refresh"],
            "items": items,
            "dropped": self.dropped,
        }


def _timeout(signum, frame):
    raise TimeoutError(f"run exceeded {RUN_TIMEOUT_SECONDS}s")


def main():
    signal.signal(signal.SIGALRM, _timeout)
    signal.alarm(RUN_TIMEOUT_SECONDS)  # a stalled connection must not hang the daily job
    try:
        feed = Builder().build()
        save_json(FEED, feed)
        log(f"ok: {len(feed['items'])} items, {len(feed['dropped'])} creators dropped")
        return 0
    except Exception as e:
        log("refresh failed: " + "".join(traceback.format_exception_only(e)).strip())
        prev = load_json(FEED, {"items": [], "dropped": []})
        prev.update(status="failed",
                    failed_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        save_json(FEED, prev)
        return 1


if __name__ == "__main__":
    sys.exit(main())
