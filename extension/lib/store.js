// chrome.storage.local wrapper and defaults. Everything Pacifier keeps lives
// here, in this browser profile only (no sync).

export const DEFAULT_CONFIG = {
  feed_size: 9,                  // decided 16 Oct 2026: 9 from the list + 1 suggestion
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

export async function getConfig() {
  const c = await store.get("config", {});
  return { ...DEFAULT_CONFIG, ...c, suggestion: { ...DEFAULT_CONFIG.suggestion, ...(c.suggestion || {}) } };
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
