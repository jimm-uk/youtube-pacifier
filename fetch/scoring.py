"""Pure functions: name matching, clickbait scoring, feed selection and
suggestion ranking. No network here — everything is unit-tested."""

import re
import unicodedata
from collections import Counter
from datetime import datetime, timedelta

BAIT_PHRASES = [
    "you won't believe", "you wont believe", "gone wrong", "shocking",
    "destroyed", "insane", "mind blowing", "mind-blowing", "jaw dropping",
    "jaw-dropping", "must watch", "must see", "watch till the end",
    "watch until the end", "nobody is talking about", "no one is talking about",
    "they don't want you to know", "this changes everything", "exposed",
    "the truth about", "will shock you", "secret", "don't miss", "last chance",
    "crazy", "unbelievable", "epic fail", "omg", "what happens next",
    "is dead", "is over", "game changer", "game-changer", "100% guaranteed",
    "get rich", "millionaire", "before it's too late", "urgent", "warning",
    "huge news", "breaking",
]
# Upper-case words that are just acronyms, not shouting.
ACRONYMS = {
    "AI", "API", "GPT", "LLM", "LLMS", "UK", "US", "USA", "EU", "CPU", "GPU",
    "AMD", "NVIDIA", "MCP", "RAG", "SQL", "AWS", "GCP", "IBM", "ETF", "ETFS",
    "ISA", "ISAS", "SIPP", "FTSE", "S&P", "BOE", "FED", "ECB", "IMF", "GDP",
    "CEO", "CTO", "IT", "PC", "OS", "IOS", "MAC", "M1", "M2", "M3", "M4", "M5",
    "RAM", "SSD", "TV", "BBC", "NHS", "LIVE", "JS", "HTML", "CSS",
    "UI", "UX", "VS", "DIY", "FAQ", "NYC", "LA", "II", "III", "IV", "OK",
}
STOPWORDS = set("""a an the and or but if of to in on at for with from by as is are
was were be been being this that these those it its it's i you he she we they
my your our their me him her us them what which who whom how why when where
not no so do does did done can could should would will just than then too very
into about over under up down out new vs part full my our more most all any
some one two three first next last best why how get got make made using use
used vs episode ep live official video videos review reviews 2024 2025 2026
s t don't isn't won't i'm you're we're""".split())

EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF"
    "\U0001F900-\U0001F9FF⭐⬆⬇⤴⤵‼⁉]")


# --- name matching -----------------------------------------------------------

def norm(s):
    s = unicodedata.normalize("NFKC", s).casefold()
    s = s.replace("’", "'").replace("‘", "'")
    return re.sub(r"\s+", " ", s).strip()


def name_matches(wanted, title):
    """'Robin Talks M…' matches by prefix; anything else must match exactly
    (case- and spacing-insensitive)."""
    w = wanted.rstrip()
    if w.endswith("…") or w.endswith("..."):
        prefix = norm(w.rstrip(".…"))
        return norm(title).startswith(prefix)
    return norm(title) == norm(w)


def pick_channel(wanted, results, min_subscribers):
    """Choose the channel for a name-only creator, or None if ambiguous/absent.

    Accept only when exactly one name-matching channel has at least
    `min_subscribers`; small namesakes are ignored."""
    matches = [r for r in results if name_matches(wanted, r["title"])]
    big = [r for r in matches if r["subscribers"] >= min_subscribers]
    if len(big) == 1:
        return big[0], matches
    return None, matches


# --- clickbait ---------------------------------------------------------------

def clickbait_score(title):
    """0 is calm. Each signal adds roughly 1; anything >= 2 is bait."""
    score = 0.0
    words = re.findall(r"[A-Za-z][A-Za-z'&0-9]*", title)
    shouty = [w for w in words if len(w) >= 3 and w.isupper() and w not in ACRONYMS]
    if shouty:
        score += min(2.0, 0.75 * len(shouty))
    bangs = title.count("!")
    if bangs:
        score += 0.75 if bangs == 1 else 1.5
    if re.search(r"\?\?|\?!|!\?", title):
        score += 1.0
    emoji = len(EMOJI_RE.findall(title))
    if emoji:
        score += min(2.0, 0.75 * emoji)
    low = title.casefold()
    phrases = sum(1 for p in BAIT_PHRASES if p in low)
    score += min(2.0, 1.0 * phrases)
    if re.search(r"(\.\.\.|…)\s*$", title):
        score += 0.5
    if re.search(r"\(\s*(gone wrong|emotional|not clickbait)\s*\)", low):
        score += 1.0
    return round(score, 2)


def mean_clickbait(titles):
    return round(sum(map(clickbait_score, titles)) / len(titles), 2) if titles else 0.0


# --- feed selection ----------------------------------------------------------

def select_feed(entries, size, max_per_creator, eligible):
    """Newest-first entries -> up to `size` items, honouring the per-creator
    cap. `eligible(entry)` is called lazily so network checks run only for
    videos that could make the cut."""
    picked, per = [], Counter()
    for e in sorted(entries, key=lambda v: v["published"], reverse=True):
        if len(picked) >= size:
            break
        if per[e["channel_id"]] >= max_per_creator:
            continue
        if eligible(e):
            picked.append(e)
            per[e["channel_id"]] += 1
    return picked


# --- suggestion --------------------------------------------------------------

def keywords(titles, n=8):
    """Most common meaningful words across titles."""
    c = Counter()
    for t in titles:
        for w in re.findall(r"[a-z][a-z0-9+#.-]{2,}", t.casefold()):
            w = w.strip(".-")
            if w not in STOPWORDS and not w.isdigit():
                c[w] += 1
    return [w for w, _ in c.most_common(n)]


def topic_overlap(candidate_titles, list_keywords):
    kws = set(list_keywords)
    if not kws:
        return 0.0
    words = set()
    for t in candidate_titles:
        words |= set(re.findall(r"[a-z][a-z0-9+#.-]{2,}", t.casefold()))
    return len(words & kws) / len(kws)


def assess_candidate(feed, now, cfg, list_keywords):
    """Score a candidate channel from its RSS entries.

    Returns (score, reasons) or (None, why_rejected)."""
    if not feed:
        return None, "no uploads"
    recent = [v for v in feed if now - _dt(v["published"]) <= timedelta(days=180)]
    if len(recent) < cfg["min_recent_uploads"]:
        return None, f"only {len(recent)} uploads in 180 days"
    span_days = max(1.0, (now - _dt(feed[-1]["published"])).total_seconds() / 86400)
    per_week = len(feed) / (span_days / 7)
    if per_week > cfg["max_uploads_per_week"]:
        return None, f"{per_week:.0f} uploads a week"
    titles = [v["title"] for v in feed]
    bait = mean_clickbait(titles)
    if bait > cfg["max_clickbait"]:
        return None, f"clickbait {bait}"
    overlap = topic_overlap(titles, list_keywords)
    # Calm titles, steady cadence and shared topics all count; overlap matters most.
    score = 2.0 * overlap + (cfg["max_clickbait"] - bait) + min(1.0, len(recent) / 12)
    cadence = ("about weekly" if 0.5 <= per_week <= 2 else
               f"about {per_week:.0f} a week" if per_week > 2 else "occasional")
    return round(score, 3), {"cadence": cadence, "clickbait": bait, "overlap": round(overlap, 2)}


SPIN_OFF_WORDS = ("clips", "clip", "shorts", "highlights", "extra", "extras",
                  "podcast", "class", "live", "vods", "archive", "plus", "too", "2")


def spin_off(candidate_title, listed_titles):
    """True for a clips/second channel of a creator already on the list
    ('Acme Clips', 'AcmeClass'), or any clips/highlights channel at all."""
    t = norm(candidate_title)
    if re.search(r"\b(clips?|shorts|highlights)\b", t):
        return True
    stem = t
    for w in SPIN_OFF_WORDS:
        stem = re.sub(r"\s*" + re.escape(w) + r"$", "", stem).strip()
    for lt in map(norm, listed_titles):
        first = lt.split()[0] if lt.split() else lt
        if stem and (stem == lt or stem.replace(" ", "") == lt.replace(" ", "")
                     or (len(first) >= 4 and stem == first)):
            return True
    return False


def blocked(entry_or_channel, cfg):
    names = {norm(x) for x in cfg.get("blocked_creators", [])}
    if norm(entry_or_channel.get("channel_id", "")) in names or \
       norm(entry_or_channel.get("channel", "")) in names:
        return True
    title = entry_or_channel.get("title", "").casefold()
    return any(k.casefold() in title for k in cfg.get("blocked_keywords", []) if k)


def _dt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))
