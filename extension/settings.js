import { store, getConfig, getCreators, settingsFile, parseSettingsFile, MAX_SETTINGS_FILE_BYTES } from "./lib/store.js";

const list = document.getElementById("creators");
const lines = s => s.split("\n").map(x => x.trim()).filter(Boolean);

async function renderCreators() {
  const creators = await getCreators();
  list.replaceChildren(...creators.map((c, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = c.title && c.title !== c.name ? `${c.name} (${c.title})` : c.name;
    const detail = document.createElement("span");
    detail.className = "meta";
    detail.textContent = c.dropped ? `Left out: ${c.dropped}`
      : c.channel_id ? (c.handle || "channel found") : "Looked up at the next refresh";
    if (c.dropped) detail.classList.add("warn");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.onclick = async () => {
      const now = await getCreators();
      now.splice(i, 1);
      await store.set("creators", now);
      renderCreators();
    };
    const priority = document.createElement("select");
    priority.setAttribute("aria-label", `Priority for ${c.name}`);
    for (const [value, label] of [["normal", "Normal"], ["high", "High"], ["low", "Low"]]) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      priority.append(o);
    }
    priority.value = c.priority || "normal";
    priority.onchange = async () => {
      const now = await getCreators();
      if (priority.value === "normal") delete now[i].priority; else now[i].priority = priority.value;
      await store.set("creators", now);
    };
    const text = document.createElement("span");
    text.append(name, detail);
    const actions = document.createElement("span");
    actions.className = "actions";
    actions.append(priority, remove);
    li.append(text, actions);
    return li;
  }));
}

document.getElementById("add").onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = f.get("name").trim();
  let handle = f.get("handle").trim();
  if (handle && !handle.startsWith("@")) handle = "@" + handle;
  const creators = await getCreators();
  creators.push({ name, ...(handle ? { handle } : {}) });
  await store.set("creators", creators);
  e.target.reset();
  renderCreators();
};

const opts = document.getElementById("options");
async function renderOptions() {
  const c = await getConfig();
  opts.list_size.value = c.feed_size + c.suggestions;
  opts.auto_refresh_hours.value = c.auto_refresh_hours;
  opts.max_per_creator.value = c.max_per_creator;
  opts.min_minutes.value = Math.round(c.min_duration_seconds / 60);
  opts.blocked_creators.value = c.suggestion.blocked_creators.join("\n");
  opts.blocked_keywords.value = c.suggestion.blocked_keywords.join("\n");
}
opts.onsubmit = async e => {
  e.preventDefault();
  const c = await getConfig();
  const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  c.feed_size = int(opts.list_size.value, 3, 30, c.feed_size + c.suggestions) - c.suggestions;
  c.auto_refresh_hours = int(opts.auto_refresh_hours.value, 0, 168, c.auto_refresh_hours);
  c.max_per_creator = int(opts.max_per_creator.value, 1, 9, c.max_per_creator);
  c.min_duration_seconds = 60 * int(opts.min_minutes.value, 1, 60, c.min_duration_seconds / 60);
  c.suggestion.blocked_creators = lines(opts.blocked_creators.value);
  c.suggestion.blocked_keywords = lines(opts.blocked_keywords.value);
  await store.set("config", c);
  const saved = document.getElementById("saved");
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 2000);
};

// --- backup -----------------------------------------------------------------
const backupStatus = document.getElementById("backup-status");
const say = (msg, warn = false) => { backupStatus.textContent = msg; backupStatus.classList.toggle("warn", warn); };

document.getElementById("export").onclick = async () => {
  const data = settingsFile(await getCreators(), await getConfig());
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `pacifier-settings-${data.exported_at.slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  say(`Exported ${data.creators.length} creators and your options.`);
};

document.getElementById("import").onchange = async e => {
  const file = e.target.files?.[0];
  e.target.value = "";   // allow loading the same file again
  if (!file) return;
  try {
    if (file.size > MAX_SETTINGS_FILE_BYTES) throw new Error("That file is too large to be a Pacifier settings file.");
    const { creators, config } = parseSettingsFile(await file.text());
    await store.set("creators", creators);
    await store.set("config", config);
    await renderCreators();
    await renderOptions();
    say(`Loaded ${creators.length} creators and options. Press Refresh now on the list to update it.`);
  } catch (err) {
    say(err.message || "Couldn't load that file.", true);
  }
};

renderCreators();
renderOptions();
