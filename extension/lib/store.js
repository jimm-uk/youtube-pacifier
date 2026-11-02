// chrome.storage.local wrapper and defaults. Everything Pacifier keeps lives
// here, in this browser profile only (no sync).

export const DEFAULT_CONFIG = {
  feed_size: 9,                  // videos from the list; with the suggestion, 10 in total (Settings: 3–30)
  suggestions: 1,
  max_per_creator: 3,
  min_duration_seconds: 180,     // also excludes Shorts
  min_subscribers_for_match: 10000,
  auto_refresh_hours: 20,        // refresh on open when older than this; 0 = only "Refresh now"
  suggestion: {
    cooldown_days: 30,
    max_clickbait: 1.0,
    min_recent_uploads: 3,
    max_uploads_per_week: 7,
    blocked_creators: [],
    blocked_keywords: [],
  },
};

// Creator entries come from storage and a hand-edited seed file, so treat
// them as untrusted: strings must be strings, IDs must look like IDs, and
// priority is "high", "low" or absent. Anything else is dropped, so a bad
// entry can't break Settings, the refresh or the list.
const str = v => (typeof v === "string" ? v : undefined);
export function cleanCreator(c) {
  if (!c || typeof c !== "object" || !str(c.name)?.trim()) return null;
  const out = { name: c.name };
  for (const k of ["handle", "title", "dropped"]) if (str(c[k])) out[k] = c[k];
  if (str(c.channel_id) && /^UC[\w-]{22}$/.test(c.channel_id)) out.channel_id = c.channel_id;
  if (c.priority === "high" || c.priority === "low") out.priority = c.priority;
  if (typeof c.subscribers === "number") out.subscribers = c.subscribers;
  if (str(c.resolved_at)) out.resolved_at = c.resolved_at;
  return out;
}
export const cleanCreators = list => (Array.isArray(list) ? list.map(cleanCreator).filter(Boolean) : []);

// Optional seed list, local to this install (creators.local.js, ignored by
// git). Missing file → start with an empty list.
async function seedCreators() {
  try {
    const list = (await import("../creators.local.js")).default;
    return cleanCreators(list);
  } catch {
    return [];
  }
}

export const store = {
  async get(key, fallback) {
    const r = await chrome.storage.local.get(key);
    return r[key] ?? fallback;
  },
  set(key, value) { return chrome.storage.local.set({ [key]: value }); },
};

// Options from storage or an imported file are untrusted: keep only the
// user-settable ones, as whole numbers in range or short lists of strings.
// Everything else comes from the defaults.
const intIn = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
const strList = v => (Array.isArray(v) ? v.filter(x => typeof x === "string" && x.trim()).map(x => x.slice(0, 200)).slice(0, 500) : []);
export function cleanConfig(c) {
  const d = DEFAULT_CONFIG, s = (c && typeof c === "object" ? c : {});
  const sg = s.suggestion && typeof s.suggestion === "object" ? s.suggestion : {};
  return {
    ...d,
    feed_size: intIn(s.feed_size, 2, 29, d.feed_size),
    max_per_creator: intIn(s.max_per_creator, 1, 9, d.max_per_creator),
    min_duration_seconds: intIn(s.min_duration_seconds, 60, 3600, d.min_duration_seconds),
    auto_refresh_hours: intIn(s.auto_refresh_hours, 0, 168, d.auto_refresh_hours),
    suggestion: { ...d.suggestion, blocked_creators: strList(sg.blocked_creators), blocked_keywords: strList(sg.blocked_keywords) },
  };
}

export async function getConfig() {
  return cleanConfig(await store.get("config", {}));
}

// --- export / load ----------------------------------------------------------
// A small JSON file with the creators and options, so they survive removing
// and reinstalling the extension, or move to another browser.
export const SETTINGS_FILE_VERSION = 1;
export const MAX_SETTINGS_FILE_BYTES = 1_000_000;

export function settingsFile(creators, config) {
  return { app: "pacifier", version: SETTINGS_FILE_VERSION, exported_at: new Date().toISOString(),
           creators: cleanCreators(creators), config: cleanConfig(config) };
}

// Parse an imported file. Throws a plain-English Error if it isn't one of ours.
export function parseSettingsFile(text) {
  if (typeof text !== "string" || text.length > MAX_SETTINGS_FILE_BYTES) throw new Error("That file is too large to be a Pacifier settings file.");
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("That file isn't valid JSON."); }
  if (!data || data.app !== "pacifier" || !Array.isArray(data.creators)) throw new Error("That isn't a Pacifier settings file.");
  if (data.version > SETTINGS_FILE_VERSION) throw new Error("That file comes from a newer version of Pacifier.");
  return { creators: cleanCreators(data.creators), config: cleanConfig(data.config) };
}

export async function getCreators() {
  const stored = await store.get("creators");
  if (stored === undefined) {
    const seeded = await seedCreators();
    await store.set("creators", seeded);
    return seeded;
  }
  return cleanCreators(stored);
}

export async function getWatched() { return store.get("watched", {}); }
export async function setWatched(id, on) {
  const w = await getWatched();
  if (on) w[id] = Date.now(); else delete w[id];
  await store.set("watched", w);
}
