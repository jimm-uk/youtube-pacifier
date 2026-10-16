# Pacifier — design and rules

A calm, private YouTube portal: the latest videos from creators the user
names, plus one carefully chosen suggestion, played with no autoplay, no
recommendations, no comments and no links out. When the list is watched,
there is nothing more to do — that is the point.

This project is the Brave/Chrome extension (`extension/`). The original
Python version (local server + launchd fetch) is a separate project,
`youtube-pacifier-server`; it is superseded, so new work goes here.

## Testing: in a VM only, never on the host
The host holds the user's real browser profile and data, so all tests —
unit and browser — run in a disposable macOS VM (Lima). The host only
copies files in. VM name and guest paths come from
`tests/extension/vm.env` (local, ignored; copy `vm.env.example`). The guest
needs Brave and Node 22+.
- `tests/extension/vm-run.sh --test` — unit tests (Node, `unit.test.mjs`).
- `tests/extension/vm-run.sh e2e.mjs` — full end-to-end run in headless
  Brave: plants fake Google/YouTube login cookies, refreshes, plays,
  pauses, seeks to the end, edits settings, then audits every request.
  All checks must pass.
- `tests/extension/vm-run.sh security.mjs` — attack/leak suite (below).
- `tests/extension/vm-run.sh empty-state.mjs` — a fresh install without
  `creators.local.js` starts empty and points to Settings.
- `diagnose.mjs` (one refresh with every fetch timed) and `probe-embed.mjs`
  (lists what the YouTube embed shows) for debugging.

Screenshots land in the guest at `/tmp/pacifier-shots/`. Stop the VM when
finished.

## What it does
- **10 videos in total:** the 9 newest eligible videos from the creator list,
  at most 3 per creator, plus 1 suggestion. No archive, no pagination.
- **Suggestion:** 1 recent video (≤ 60 days) from a creator *not* on the
  list, labelled "Suggestion — not on your list". If nothing passes the
  bar, the 10th slot goes to the list. Never added to the list automatically.
- **Refresh:** a "Refresh now" button, plus an automatic refresh when the
  portal opens and the list is older than 20 hours (Settings; 0 = button
  only). No background schedule — nothing runs while Pacifier is closed.
- **Creator priority** (Settings, per creator): **high** — their newest
  eligible video is guaranteed a place if under 14 days old; **normal** —
  newest first as space allows; **low** — only fills places left after
  everyone else. The per-creator cap still applies; the list still displays
  newest first. Implemented in `selectFeed` (`lib/scoring.js`), unit-tested.
- **Watched** videos stay greyed until newer ones push them off.
- **Settings** page: add (name and/or @handle) and remove creators; options.

## Layout (`extension/`)
- `manifest.json` — MV3. Permissions: `storage`, `declarativeNetRequest`;
  hosts: `www.youtube.com`, `www.youtube-nocookie.com` only. Keep it that way.
- `background.js` — toolbar button opens/focuses the portal. Nothing else.
- `portal.html/js/css` — the list and the player. `settings.html/js/css`.
- `lib/youtube.js` — all YouTube access. **The only file that knows
  YouTube's page structure.**
- `lib/scoring.js` — pure logic (matching, clickbait, selection, suggestion
  ranking, spin-offs, script check). Unit-tested; ported from the server version's `fetch/scoring.py`.
- `lib/refresh.js` — the run: resolve → fetch → filter → suggest → store.
  3-minute deadline; a failure keeps the previous list, marked failed.
- `lib/player.js` — drives the embed over postMessage (extensions may not
  load YouTube's IFrame API script; this is the protocol it uses).
- `lib/net.js` — declarativeNetRequest session rules, **scoped to
  Pacifier's own tab IDs** (unit test enforces it).
- `lib/store.js` — `chrome.storage.local` and defaults. The first run seeds
  the creator list from `creators.local.js` if present (local, ignored;
  format in `creators.example.js`), otherwise starts empty.
- `embed-filter.js` — cosmetic filter inside the embed (see below).

## Privacy and security model
Run `tests/extension/vm-run.sh security.mjs` (VM only) after any change to
`manifest.json`, `lib/net.js`, `lib/player.js`, `embed-filter.js` or anything
that renders data. All checks must pass. It covers: XSS from poisoned
titles/names/storage, CSP (eval, inline/remote script, exfiltration),
hostile websites (read/frame/message the extension), forged player
messages, the embed filter staying inert elsewhere, every host contacted,
the extension ID in URLs/headers/bodies, planted cookies, and rule scope.

- **Permissions:** `storage`, `declarativeNetRequest`; hosts
  `www.youtube.com`, `www.youtube-nocookie.com`. No web-accessible
  resources; `externally_connectable: {ids: []}` (no site or extension can
  message it). Plain `declarativeNetRequest` (not `…WithHostAccess`) is
  needed so block rules work on ad hosts we have no host permission for.
- **Cookies:** our fetches use `credentials: "omit"`; youtube.com fetches
  carry only `SOCS=CAI` (anonymous "reject all" consent flag). The player
  iframe is `credentialless` (temporary empty cookie jar).
- **Rule scope:** every network rule requires the request to come from a
  Pacifier tab AND be initiated by the extension (or the embed inside it),
  and never applies to `main_frame`. Tabs are released on `pagehide` and
  `tabs.onRemoved`. Normal YouTube browsing is untouched (tested).
- **Blocked in Pacifier's tab:** doubleclick/googlesyndication/ads/analytics
  hosts, `/api/stats/ads`, `/pagead/`, `/ptracking`, `log_event`, and
  Google's fingerprinting: BotGuard (`google.com/js/th/`) and attestation
  (`jnn-pa.googleapis.com`). If YouTube ever refuses to play without
  attestation, those two are the ones to unblock.
- **Extension ID:** the embed gets no `origin` parameter and
  `referrerpolicy="no-referrer"`, so the ID is in no URL, header or body
  (tested). **Known residual risk:** YouTube's scripts in the embed can
  still *read* it via `location.ancestorOrigins`, which Chromium neither
  masks nor lets anyone override. Nothing observed transmits it, but
  BotGuard-style encrypted payloads couldn't be inspected — hence blocking
  them. The unpacked ID is derived from the folder path.
- **Input:** video/channel IDs must match `^[\w-]{11}$` / `^UC[\w-]{22}$`;
  anything else from YouTube is dropped. Caches keyed by IDs are
  null-prototype objects. Creator entries (from storage or the seed file)
  pass through `cleanCreators` (`lib/store.js`): strings must be strings,
  IDs must match, priority is `high`/`low`/absent — so a malformed entry
  can't break Settings or a refresh. All rendering uses `textContent`; CSP
  forbids inline script and eval.
- **Remaining trust:** YouTube itself (the embed can send our page player
  messages — worst case it ends a video early) and Brave.

## Distraction-free rules (non-negotiable)
- No thumbnails, view counts, likes, comments, "up next", badges or
  counters. Cards: title, creator, date, duration.
- YouTube's embed (2026 player, `ytm…` classes) ignores `controls=0` and
  still shows title/avatar links, Copy link, "More videos" and "Watch on
  YouTube" for a few seconds after play/seek. Counters:
  - `embed-filter.js` hides every link and those overlays with CSS —
    Brave/uBlock-style cosmetic filtering, active only when the embed's
    parent is a Pacifier page;
  - a shield over the whole picture (clicks play/pause through our code);
  - our own controls: play/pause, seek, time, mute, captions, full screen;
    keys space/k, ←/→ (5 s), m, c, f, Esc;
  - a black overlay on pause; on `ENDED`, straight back to the list.
- These depend on YouTube's player. **After YouTube changes, run
  `probe-embed.mjs`, update `embed-filter.js`, re-run e2e.**
- Quiet typography, light/dark from the system, no motion.

## Standing rules
- No dependencies, no build step, no remote code. Plain ES modules.
- Never download or re-host video files (breaches YouTube's terms).
- Be polite to YouTube: caches stay; no request loops.
- Unit + e2e must pass in the VM before a change is finished.
- Status vocabulary: set `review`, never `done` — only the user marks `done`.

## Decided — do not re-open
- 10 videos in total: 9 from the list + 1 suggestion. `max_per_creator = 3`.
- Creator priority is three levels (high / normal / low), not numeric
  weights.
- Watched videos stay greyed until they age off.
- Ambiguous creators are dropped; the user adds them back with a handle.
- Keyless scraping rather than the YouTube Data API.
- Extension, not a local server: "Refresh now" + refresh-on-open, no
  background schedule. Cookie-free throughout.
- Test only in the VM.

## Known weak spots
- An intermittent refresh stall, seen twice in ~15 VM runs and not
  reproducible on demand. The 3-minute deadline turns it into "Refresh
  failed — showing the list from …"; the failed feed records `stage`. If it
  recurs, run `diagnose.mjs` and look there.
- Suggestion quality. Candidates come from the seed creator's featured
  channels and a keyword search; the keyword search can surface corporate
  or off-audience channels (e.g. a fund house's marketing for a personal
  finance seed). Filters exist for clickbait, volume, spin-offs and
  non-Latin scripts; more may be needed — improve with evidence from what's
  actually suggested.

## Hypothetical: publishing to the Chrome Web Store (not pursued)
Considered and decided against; the extension is loaded unpacked. Brave
installs from the Chrome Web Store (CWS), so CWS is the relevant store.
Recorded here in case it comes up again.

**What it would take**
- A CWS developer account: Google account with 2-step verification, a
  one-off US$5 fee and identity checks. An EU "trader" declaration makes
  the developer's name, address, email and phone public.
- A zip of `extension/` without `creators.local.js` (the empty state covers
  a fresh install), the `window.pacifierPlayer` test hook removed, and a
  version scheme.
- A listing: description of 132 characters or fewer, 1280×800
  screenshot(s), 440×280 promo tile, category, 128 px icon. No YouTube logo
  or anything implying it's a YouTube product.
- Privacy section: single-purpose statement, a justification for each
  permission, "no remote code", no user data collected, and a published
  privacy policy.
- A manual review (host permissions + `declarativeNetRequest`) on first
  submission and every update: days, sometimes weeks. Public or **unlisted**
  (link-only) visibility.

**The obstacle: YouTube's terms.** Google owns both YouTube and the store, so
a reviewer or a later complaint could reject the extension or remove it.
- `embed-filter.js` hides YouTube branding and links, which YouTube's
  embedded-player policies forbid.
- Blocking BotGuard and attestation could be seen as interfering with
  YouTube's systems (ad blocking alone is accepted on the store).
- Reading YouTube's pages instead of the official Data API goes against
  YouTube's terms, and with many users it would hit rate limits for everyone.

A store-safe build would likely keep the click shield but drop the cosmetic
filter, and move to the Data API. The API needs a key and has a daily quota,
so it would need a key per user or a backend. Both changes weaken what makes
Pacifier calm and private.

**Pros:** one-click install anywhere; no developer-mode banner; automatic
updates; Google's security review. The extension ID would be the same for
every user (not derived from a local path), which softens the
`ancestorOrigins` residual risk.

**Cons:** likely rejection or later removal unless features are cut;
public developer identity (if a trader); every fix waits for review while
users stay broken; an ongoing support commitment; scraping at scale is
fragile and more visible.

**If it is ever pursued:** build the zip without local files, load that in
the VM and run unit, e2e, security and empty-state against it, and check
that the store's install warnings match the README.
