// Pure functions: name matching, clickbait scoring, feed selection and
// suggestion ranking. No network or browser APIs — unit-tested under Node.

const BAIT_PHRASES = [
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
];
// Upper-case words that are just acronyms, not shouting.
const ACRONYMS = new Set(`AI API GPT LLM LLMS UK US USA EU CPU GPU AMD NVIDIA MCP RAG SQL AWS
  GCP IBM ETF ETFS ISA ISAS SIPP FTSE S&P BOE FED ECB IMF GDP CEO CTO IT PC OS IOS MAC M1 M2
  M3 M4 M5 RAM SSD TV BBC NHS LIVE JS HTML CSS UI UX VS DIY FAQ NYC LA II III IV OK`
  .split(/\s+/).filter(Boolean));
const STOPWORDS = new Set(`a an the and or but if of to in on at for with from by as is are
  was were be been being this that these those it its it's i you he she we they my your our
  their me him her us them what which who whom how why when where not no so do does did done
  can could should would will just than then too very into about over under up down out new vs
  part full more most all any some one two three first next last best get got make made using
  use used episode ep live official video videos review reviews 2024 2025 2026 s t don't isn't
  won't i'm you're we're`.split(/\s+/).filter(Boolean));
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}⭐⬆⬇⤴⤵‼⁉]/gu;
const DAY = 86400e3;

// --- name matching -----------------------------------------------------------

export function norm(s) {
  return (s || "").normalize("NFKC").toLowerCase()
    .replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

// "Robin Talks M…" matches by prefix; anything else must match exactly.
export function nameMatches(wanted, title) {
  const w = wanted.trimEnd();
  if (w.endsWith("…") || w.endsWith("...")) return norm(title).startsWith(norm(w.replace(/[.…]+$/, "")));
  return norm(title) === norm(w);
}

// Accept only when exactly one name-matching channel is sizeable.
export function pickChannel(wanted, results, minSubscribers) {
  const matches = results.filter(r => nameMatches(wanted, r.title));
  const big = matches.filter(r => r.subscribers >= minSubscribers);
  return { best: big.length === 1 ? big[0] : null, matches };
}

// --- clickbait ---------------------------------------------------------------

// 0 is calm. Each signal adds roughly 1; anything >= 2 is bait.
export function clickbaitScore(title) {
  let score = 0;
  const words = title.match(/[A-Za-z][A-Za-z'&0-9]*/g) || [];
  const shouty = words.filter(w => w.length >= 3 && w === w.toUpperCase() && /[A-Z]/.test(w) && !ACRONYMS.has(w));
  if (shouty.length) score += Math.min(2, 0.75 * shouty.length);
  const bangs = (title.match(/!/g) || []).length;
  if (bangs) score += bangs === 1 ? 0.75 : 1.5;
  if (/\?\?|\?!|!\?/.test(title)) score += 1;
  const emoji = (title.match(EMOJI_RE) || []).length;
  if (emoji) score += Math.min(2, 0.75 * emoji);
  const low = title.toLowerCase();
  score += Math.min(2, BAIT_PHRASES.filter(p => low.includes(p)).length);
  if (/(\.\.\.|…)\s*$/.test(title)) score += 0.5;
  if (/\(\s*(gone wrong|emotional|not clickbait)\s*\)/.test(low)) score += 1;
  return Math.round(score * 100) / 100;
}

export function meanClickbait(titles) {
  if (!titles.length) return 0;
  return Math.round(titles.reduce((a, t) => a + clickbaitScore(t), 0) / titles.length * 100) / 100;
}

// --- feed selection ----------------------------------------------------------

// Newest-first entries -> up to `size` items, honouring the per-creator cap.
// `eligible(entry)` may be async and is called lazily, newest first, so
// network checks run only for videos that could make the cut.
export async function selectFeed(entries, size, maxPerCreator, eligible) {
  const picked = [], per = new Map();
  const sorted = [...entries].sort((a, b) => b.published.localeCompare(a.published));
  for (const e of sorted) {
    if (picked.length >= size) break;
    if ((per.get(e.channel_id) || 0) >= maxPerCreator) continue;
    if (await eligible(e)) {
      picked.push(e);
      per.set(e.channel_id, (per.get(e.channel_id) || 0) + 1);
    }
  }
  return picked;
}

// --- suggestion --------------------------------------------------------------

const WORD_RE = /[a-z][a-z0-9+#.-]{2,}/g;

export function keywords(titles, n = 8) {
  const c = new Map();
  for (const t of titles) {
    for (let w of t.toLowerCase().match(WORD_RE) || []) {
      w = w.replace(/^[.-]+|[.-]+$/g, "");
      if (w && !STOPWORDS.has(w) && !/^\d+$/.test(w)) c.set(w, (c.get(w) || 0) + 1);
    }
  }
  // Stable: by count, then first appearance (Map keeps insertion order).
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

export function topicOverlap(candidateTitles, listKeywords) {
  const kws = new Set(listKeywords);
  if (!kws.size) return 0;
  const words = new Set();
  for (const t of candidateTitles) for (const w of t.toLowerCase().match(WORD_RE) || []) words.add(w);
  let hit = 0;
  for (const k of kws) if (words.has(k)) hit++;
  return hit / kws.size;
}

// Score a candidate channel from its RSS entries (newest first).
export function assessCandidate(feed, now, cfg, listKeywords) {
  if (!feed.length) return { score: null, why: "no uploads" };
  const t = e => Date.parse(e.published);
  const recent = feed.filter(v => now - t(v) <= 180 * DAY);
  if (recent.length < cfg.min_recent_uploads) return { score: null, why: `only ${recent.length} uploads in 180 days` };
  const spanDays = Math.max(1, (now - t(feed[feed.length - 1])) / DAY);
  const perWeek = feed.length / (spanDays / 7);
  if (perWeek > cfg.max_uploads_per_week) return { score: null, why: `${Math.round(perWeek)} uploads a week` };
  const titles = feed.map(v => v.title);
  if (nonLatinShare(titles) > 0.2) return { score: null, why: "titles not in a Latin script" };
  const bait = meanClickbait(titles);
  if (bait > cfg.max_clickbait) return { score: null, why: `clickbait ${bait}` };
  const overlap = topicOverlap(titles, listKeywords);
  const score = 2 * overlap + (cfg.max_clickbait - bait) + Math.min(1, recent.length / 12);
  const cadence = perWeek >= 0.5 && perWeek <= 2 ? "about weekly"
    : perWeek > 2 ? `about ${Math.round(perWeek)} a week` : "occasional";
  return { score: Math.round(score * 1000) / 1000, cadence, clickbait: bait, overlap: Math.round(overlap * 100) / 100 };
}

// Share of letters outside the Latin script — a cheap proxy for "not in
// English" that keeps suggestions readable.
export function nonLatinShare(titles) {
  // Count combining marks too: many scripts (e.g. Tamil) write vowels as marks.
  const chars = titles.join(" ").normalize("NFC").match(/[\p{L}\p{M}]/gu) || [];
  if (!chars.length) return 0;
  return chars.filter(c => !/[\p{Script=Latin}\p{Script=Inherited}]/u.test(c)).length / chars.length;
}

const SPIN_OFF_WORDS = ["clips", "clip", "shorts", "highlights", "extra", "extras",
                        "podcast", "class", "live", "vods", "archive", "plus", "too", "2"];

// A clips/second channel of a listed creator ("Acme Clips", "AcmeClass"),
// or any clips/highlights channel at all.
export function spinOff(candidateTitle, listedTitles) {
  const t = norm(candidateTitle);
  if (/\b(clips?|shorts|highlights)\b/.test(t)) return true;
  let stem = t;
  for (const w of SPIN_OFF_WORDS) stem = stem.replace(new RegExp("\\s*" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), "").trim();
  for (const lt of listedTitles.map(norm)) {
    const first = lt.split(" ")[0] || lt;
    if (stem && (stem === lt || stem.replace(/ /g, "") === lt.replace(/ /g, "") ||
                 (first.length >= 4 && stem === first))) return true;
  }
  return false;
}

export function blocked(e, cfg) {
  const names = new Set((cfg.blocked_creators || []).map(norm));
  if (names.has(norm(e.channel_id)) || names.has(norm(e.channel))) return true;
  const title = (e.title || "").toLowerCase();
  return (cfg.blocked_keywords || []).some(k => k && title.includes(k.toLowerCase()));
}
