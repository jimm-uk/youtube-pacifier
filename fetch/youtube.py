"""Keyless access to YouTube: public RSS feeds plus the JSON embedded in
public pages. Everything that depends on YouTube's page structure lives in
this module, so when YouTube changes something, this is the file to fix."""

import html
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
HEADERS = {
    "User-Agent": UA,
    "Accept-Language": "en-GB,en;q=0.8",
    # Skips the EU/UK cookie-consent interstitial.
    "Cookie": "SOCS=CAI; CONSENT=YES+1",
}
CHANNELS_FILTER = "EgIQAg%3D%3D"  # search results: channels only

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}


def _ssl_context():
    """python.org builds of Python on macOS ship without root certificates;
    fall back to the system bundle rather than disabling verification."""
    paths = ssl.get_default_verify_paths()
    if not (paths.cafile and os.path.exists(paths.cafile)) and os.path.exists("/etc/ssl/cert.pem"):
        return ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    return ssl.create_default_context()


SSL = _ssl_context()


class YouTubeError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _get(url, retries=2, timeout=20):
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=SSL) as r:
                return r.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError) as e:
            if isinstance(e, urllib.error.HTTPError) and e.code == 404:
                raise YouTubeError(f"404 {url}") from e
            if attempt == retries:
                raise YouTubeError(f"{e} {url}") from e
            time.sleep(1.5 * (attempt + 1))


def _embedded_json(html, var):
    """Pull `var <name> = {...};` out of a page without regex-matching braces."""
    m = re.search(r"(?:var\s+)?" + re.escape(var) + r"\s*=\s*", html)
    if not m:
        raise YouTubeError(f"{var} not found in page")
    obj, _ = json.JSONDecoder().raw_decode(html, m.end())
    return obj


def _walk(o, key):
    if isinstance(o, dict):
        if key in o:
            yield o[key]
        for v in o.values():
            yield from _walk(v, key)
    elif isinstance(o, list):
        for v in o:
            yield from _walk(v, key)


def _text(t):
    if not t:
        return ""
    if "simpleText" in t:
        return t["simpleText"]
    return "".join(r.get("text", "") for r in t.get("runs", []))


def parse_count(s):
    """'601k subscribers' -> 601000; '1.2M' -> 1200000; '' -> 0."""
    m = re.search(r"([\d.,]+)\s*([kKmMbB]|thousand|million|billion)?", s or "")
    if not m:
        return 0
    n = float(m.group(1).replace(",", ""))
    mult = {"k": 1e3, "thousand": 1e3, "m": 1e6, "million": 1e6,
            "b": 1e9, "billion": 1e9}.get((m.group(2) or "").lower(), 1)
    return int(n * mult)


def resolve_handle(handle):
    """'@ExampleChannel' -> {'channel_id', 'title'}"""
    html = _get("https://www.youtube.com/" + urllib.parse.quote(handle))
    m = re.search(r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[\w-]{22})"', html)
    if not m:
        raise YouTubeError(f"no channel for {handle}")
    t = re.search(r'<meta property="og:title" content="([^"]*)"', html)
    return {"channel_id": m.group(1), "title": _unescape(t.group(1)) if t else handle}


def search_channels(query):
    """Channel search. Returns [{'channel_id', 'title', 'handle', 'subscribers'}]."""
    url = ("https://www.youtube.com/results?search_query="
           + urllib.parse.quote_plus(query) + "&sp=" + CHANNELS_FILTER)
    for attempt in range(2):  # YouTube occasionally returns an empty result page
        data = _embedded_json(_get(url), "ytInitialData")
        if any(True for _ in _walk(data, "channelRenderer")):
            break
        time.sleep(2)
    out = []
    for r in _walk(data, "channelRenderer"):
        # YouTube currently puts the @handle in subscriberCountText and the
        # subscriber count in videoCountText; accept either arrangement.
        a, b = _text(r.get("subscriberCountText")), _text(r.get("videoCountText"))
        handle = a if a.startswith("@") else (b if b.startswith("@") else "")
        subs = b if "subscriber" in b else (a if "subscriber" in a else "")
        out.append({
            "channel_id": r["channelId"],
            "title": _text(r.get("title")).strip(),
            "handle": handle,
            "subscribers": parse_count(subs),
        })
    return out


def featured_channels(channel_id):
    """Channel IDs a creator features on their own Channels tab."""
    try:
        html = _get(f"https://www.youtube.com/channel/{channel_id}/channels")
    except YouTubeError:
        return []
    data = _embedded_json(html, "ytInitialData")
    ids = [r.get("channelId") for r in _walk(data, "gridChannelRenderer")]
    return [i for i in dict.fromkeys(ids) if i and i != channel_id]


def channel_feed(channel_id):
    """Latest ~15 uploads from the public RSS feed, newest first."""
    xml = _get(f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}")
    return parse_feed(xml)


def parse_feed(xml):
    root = ET.fromstring(xml)
    title = root.findtext("atom:title", "", NS)
    out = []
    for e in root.findall("atom:entry", NS):
        group = e.find("media:group", NS)
        out.append({
            "id": e.findtext("yt:videoId", "", NS),
            "title": e.findtext("atom:title", "", NS),
            "channel_id": e.findtext("yt:channelId", "", NS),
            "channel": e.findtext("atom:author/atom:name", title, NS),
            "published": e.findtext("atom:published", "", NS),
            "description": group.findtext("media:description", "", NS) if group is not None else "",
        })
    out.sort(key=lambda v: v["published"], reverse=True)
    return out


def video_info(video_id):
    """Duration and playability from the watch page.

    Returns {'duration', 'live', 'upcoming', 'playable', 'embeddable', 'final'}.
    'final' is False for anything that may change (live, upcoming), so the
    caller knows not to cache it."""
    html = _get(f"https://www.youtube.com/watch?v={video_id}")
    pr = _embedded_json(html, "ytInitialPlayerResponse")
    vd = pr.get("videoDetails", {})
    ps = pr.get("playabilityStatus", {})
    live = bool(vd.get("isLive")) or "liveStreamability" in ps
    upcoming = bool(vd.get("isUpcoming"))
    info = {
        "duration": int(vd.get("lengthSeconds") or 0),
        "live": live,
        "upcoming": upcoming,
        "playable": ps.get("status") == "OK",
        "embeddable": ps.get("playableInEmbed", True) is not False,
        "final": not (live or upcoming) and ps.get("status") == "OK",
    }
    return info


def is_short(video_id):
    """/shorts/<id> answers 200 for a Short and redirects for anything else."""
    opener = urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=SSL))
    req = urllib.request.Request(f"https://www.youtube.com/shorts/{video_id}",
                                 headers=HEADERS, method="HEAD")
    try:
        with opener.open(req, timeout=15) as r:
            return r.status == 200
    except urllib.error.URLError:  # includes the HTTPError raised for a redirect
        return False


def _unescape(s):
    return html.unescape(s)


def parse_time(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))
