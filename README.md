# Pacifier

Ten YouTube videos at a time: the 9 newest from your creators and 1
suggestion. Nothing else on the page, and no cookies.

## Install in Brave (or Chrome)
1. Open `brave://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose `~/Projects/youtube-pacifier/extension`.
3. Pin it: puzzle-piece icon → pin **Pacifier**. Click it to open.

Brave will say Pacifier can "read and change your data on www.youtube.com
and www.youtube-nocookie.com" and "block content on any page". It needs the
first to fetch your list and play videos without cookies, and the second to
block ads and trackers — only inside Pacifier's own tab. Your normal YouTube
browsing is untouched.

To start with a list of creators, copy `extension/creators.example.js` to
`extension/creators.local.js` and edit it before loading the extension (it
stays on your machine — git ignores it). Otherwise, add creators in Settings.
The first fetch takes about 30 seconds.

## Everyday
- Click a title to watch. Click the picture, or press space, to play or
  pause. ← / → skip 5 seconds; m mutes; c toggles captions; f is full
  screen; Esc goes back.
- When a video ends, you're back at the list and it's greyed out.
- **Refresh now** fetches new videos. Pacifier also refreshes by itself when
  you open it and the list is more than 20 hours old (change in Settings).

## Creators and options
**Settings** (link at the bottom of the list, or right-click the icon →
Options). A handle (the `@name` in a channel's address) is the surest way to
add a creator. A name alone is searched, and it's left out if more than one
sizeable channel has that name.

## For developers
Design, security model and rules: `docs/DESIGN.md`. Tests run only in a
macOS VM (copy `tests/extension/vm.env.example` to `vm.env`), via
`tests/extension/vm-run.sh --test`, `… e2e.mjs` and `… security.mjs`.
