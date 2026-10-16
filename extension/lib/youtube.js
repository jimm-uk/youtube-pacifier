// Keyless, cookie-free access to YouTube: public RSS feeds plus the JSON
// embedded in public pages. Everything that depends on YouTube's page
// structure lives in this file.
//
// Requests use credentials: "omit"; the tab's network rules (net.js) add
// only YouTube's anonymous "reject all" consent flag.

export class YouTubeError extends Error {}

// Strict ID formats. Anything else from YouTube is dropped, so hostile data
// can't reach object keys (e.g. "__proto__") or URLs.
export const isVideoId = s => typeof s === "string" && /^[\w-]{11}$/.test(s);
export const isChannelId = s => typeof s === "string" && /^UC[\w-]{22}$/.test(s);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { credentials: "omit", cache: "no-store", redirect: "follow",
                                   signal: AbortSignal.timeout(20000) });
      if (r.status === 404) throw new YouTubeError(`404 ${url}`);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      if (new URL(r.url).host === "consent.youtube.com") throw new YouTubeError(`consent page for ${url}`);
      return await r.text();
    } catch (e) {
      if (e instanceof YouTubeError || attempt >= retries) throw e instanceof YouTubeError ? e : new YouTubeError(String(e.message || e));
      await sleep(1500 * (attempt + 1));
    }
  }
}

// Pull `var <name> = {...};` out of a page by matching braces (strings aware).
export function embeddedJson(html, name) {
  const m = new RegExp("(?:var\\s+)?" + name + "\\s*=\\s*\\{").exec(html);
  if (!m) throw new YouTubeError(`${name} not found in page`);
  const start = m.index + m[0].length - 1;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new YouTubeError(`${name} unterminated`);
}

function* walk(o, key) {
  if (Array.isArray(o)) for (const v of o) yield* walk(v, key);
  else if (o && typeof o === "object") {
    if (key in o) yield o[key];
    for (const v of Object.values(o)) yield* walk(v, key);
  }
}

const text = t => !t ? "" : t.simpleText ?? (t.runs || []).map(r => r.text || "").join("");

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ENTITIES[e.toLowerCase()] ?? m);
}

// "601k subscribers" -> 601000; "1.36M" -> 1360000; "" -> 0.
export function parseCount(s) {
  const m = /([\d.,]+)\s*([kmb]|thousand|million|billion)?/i.exec(s || "");
  if (!m) return 0;
  const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 }[(m[2] || "").toLowerCase()] || 1;
  return Math.round(parseFloat(m[1].replace(/,/g, "")) * mult);
}

export async function resolveHandle(handle) {
  const html = await get("https://www.youtube.com/" + encodeURIComponent(handle).replace("%40", "@"));
  const m = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html);
  if (!m) throw new YouTubeError(`no channel for ${handle}`);
  const t = /<meta property="og:title" content="([^"]*)"/.exec(html);
  return { channel_id: m[1], title: t ? unescapeXml(t[1]) : handle };
}

export async function searchChannels(query) {
  const url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(query) + "&sp=EgIQAg%253D%253D";
  let data;
  for (let attempt = 0; attempt < 2; attempt++) { // YouTube occasionally returns an empty page
    data = embeddedJson(await get(url), "ytInitialData");
    if (!walk(data, "channelRenderer").next().done) break;
    await sleep(2000);
  }
  const out = [];
  for (const r of walk(data, "channelRenderer")) {
    if (!isChannelId(r.channelId)) continue;
    // YouTube puts the @handle in subscriberCountText and the count in
    // videoCountText; accept either arrangement.
    const a = text(r.subscriberCountText), b = text(r.videoCountText);
    out.push({
      channel_id: r.channelId,
      title: text(r.title).trim(),
      handle: a.startsWith("@") ? a : b.startsWith("@") ? b : "",
      subscribers: parseCount(b.includes("subscriber") ? b : a.includes("subscriber") ? a : ""),
    });
  }
  return out;
}

export async function featuredChannels(channelId) {
  let html;
  try { html = await get(`https://www.youtube.com/channel/${channelId}/channels`); } catch { return []; }
  const ids = [...walk(embeddedJson(html, "ytInitialData"), "gridChannelRenderer")].map(r => r.channelId);
  return [...new Set(ids)].filter(i => isChannelId(i) && i !== channelId);
}

export async function channelFeed(channelId) {
  if (!isChannelId(channelId)) throw new YouTubeError("bad channel id");
  return parseFeed(await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`));
}

// YouTube's Atom feed, parsed with regexes (no DOMParser in tests).
export function parseFeed(xml) {
  const tag = (s, name) => {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(s);
    return m ? unescapeXml(m[1].trim()) : "";
  };
  const head = xml.split("<entry>")[0];
  const feedTitle = tag(head, "title");
  const out = [];
  for (const [, e] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    out.push({
      id: tag(e, "yt:videoId"),
      title: tag(e, "title"),
      channel_id: tag(e, "yt:channelId"),
      channel: tag(/<author>[\s\S]*?<\/author>/.exec(e)?.[0] || "", "name") || feedTitle,
      published: tag(e, "published"),
      description: tag(e, "media:description"),
    });
  }
  return out.filter(v => isVideoId(v.id) && isChannelId(v.channel_id) && !Number.isNaN(Date.parse(v.published)))
            .sort((a, b) => b.published.localeCompare(a.published));
}

// Duration and playability from the watch page. `final` is false for
// anything that may still change (live, upcoming), so it isn't cached.
export async function videoInfo(videoId) {
  if (!isVideoId(videoId)) throw new YouTubeError("bad video id");
  const pr = embeddedJson(await get(`https://www.youtube.com/watch?v=${videoId}`), "ytInitialPlayerResponse");
  const vd = pr.videoDetails || {}, ps = pr.playabilityStatus || {};
  const live = Boolean(vd.isLive) || "liveStreamability" in ps;
  const upcoming = Boolean(vd.isUpcoming);
  return {
    duration: parseInt(vd.lengthSeconds || "0", 10),
    live, upcoming,
    playable: ps.status === "OK",
    embeddable: ps.playableInEmbed !== false,
    final: !(live || upcoming) && ps.status === "OK",
  };
}

// /shorts/<id> answers 200 for a Short and redirects for anything else.
export async function isShort(videoId) {
  try {
    const r = await fetch(`https://www.youtube.com/shorts/${videoId}`,
      { method: "HEAD", credentials: "omit", redirect: "manual" });
    return r.status === 200;
  } catch { return false; }
}
