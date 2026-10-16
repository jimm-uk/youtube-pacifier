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

// Optional seed list, local to this install (creators.local.js, ignored by
// git). Missing file → start with an empty list.
async function seedCreators() {
  try {
    const list = (await import("../creators.local.js")).default;
    return Array.isArray(list) ? list.filter(c => c && typeof c.name === "string") : [];
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
  let c = await store.get("creators");
  if (!c) { c = await seedCreators(); await store.set("creators", c); }
  return c;
}

export async function getWatched() { return store.get("watched", {}); }
export async function setWatched(id, on) {
  const w = await getWatched();
  if (on) w[id] = Date.now(); else delete w[id];
  await store.set("watched", w);
}
