# Pacifier

A calm way to watch YouTube. Pacifier is a browser extension for Brave or
Chrome. It shows ten videos at a time: the 9 newest from creators you choose,
plus 1 suggestion from a similar creator. Nothing else is on the page: no
thumbnails, no autoplay, no recommendations, no comments, no links out. Once
you've watched the list, there's nothing more to do.

## What it does
- **Your creators, newest first:** at most 3 videos per creator, so no single
  channel takes over. Shorts, live streams and premieres are skipped.
- **One suggestion:** a recent video from a creator not on your list, chosen
  for calm titles and steady output. It's clearly labelled and never added to
  your list automatically.
- **A quiet player:** our own simple controls, with YouTube's overlays,
  "More videos" and end-screen links hidden. Pausing blanks the picture, and
  when a video ends you're back at the list, where it's greyed out.
- **No cookies:** your YouTube or Google sign-in is never sent. The player
  runs in a temporary, empty cookie jar, and ads and trackers are blocked
  inside Pacifier's tab. Your normal YouTube browsing is untouched.
- **No API key, no server, no account.** Nothing runs while Pacifier is
  closed.

## Install
Pacifier isn't in the Chrome Web Store, so it's loaded unpacked. It needs a
Chromium-based browser, version 120 or later.

1. Download this repository (clone it, or Code → Download ZIP and unzip it).
2. Optional: to start with your own list, copy `extension/creators.example.js`
   to `extension/creators.local.js` and edit it. Otherwise, add creators in
   Settings later.
3. Open `brave://extensions` (or `chrome://extensions`) and turn on
   **Developer mode**.
4. Click **Load unpacked** and choose the `extension` folder.
5. Pin **Pacifier** to the toolbar and click it. The first fetch takes about
   30 seconds.

The browser will say Pacifier can "read and change your data on
www.youtube.com and www.youtube-nocookie.com" and "block content on any
page". It needs the first to fetch your list and play videos without
cookies, and the second to block ads and trackers, only inside Pacifier's own
tab.

## Using it
- Click a title to watch. Click the picture or press space to play or pause.
  ← / → skip 5 seconds; m mutes; c toggles captions; f is full screen; Esc
  goes back.
- **Refresh now** fetches new videos. Pacifier also refreshes by itself when
  you open it and the list is more than 20 hours old (change in Settings).
- **Settings** (link at the bottom of the list, or right-click the icon →
  Options) is where you add or remove creators. A handle (the `@name` in a
  channel's address) is the surest way to add one. A name alone is searched,
  and it's left out if more than one sizeable channel has that name.

## Limits
- Pacifier reads YouTube's public pages and feeds rather than an official
  API. When YouTube changes them, parts can break until the extension is
  updated.
- It changes how YouTube's embedded player looks and blocks some of its
  requests. That's fine for personal use, but it's why Pacifier isn't
  published in the Chrome Web Store (see `docs/DESIGN.md`).
- Suggestions are heuristic and sometimes miss.

## For developers
The design, security model and rules are in `docs/DESIGN.md`. There are no
dependencies and no build step; the extension is plain ES modules. Tests run
in a disposable macOS VM, never on the host, because they drive a real
browser profile:
copy `tests/extension/vm.env.example` to `vm.env`, then run
`tests/extension/vm-run.sh --test` (unit), `… e2e.mjs`, `… security.mjs` and
`… empty-state.mjs`.

## Licence
MIT — see `LICENSE`. Pacifier is not affiliated with, endorsed by or
connected to YouTube or Google. YouTube is a trademark of Google LLC.
