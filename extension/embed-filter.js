// Cosmetic filtering inside Pacifier's own player — the technique Brave
// Shields and uBlock Origin use: hide YouTube's overlay links with CSS.
// Runs in youtube-nocookie embeds, but does nothing unless the embed sits
// directly in a Pacifier page, so embeds on other sites are untouched.
(() => {
  const pacifier = new URL(chrome.runtime.getURL("")).origin;
  if (location.ancestorOrigins?.[0] !== pacifier) return;

  const HIDE = [
    // Every link in an embed leads out to YouTube: title, channel, avatar,
    // "Watch on YouTube", related videos, error-page links.
    "a",
    // Current (2026) embed player.
    "[class*='ytmVideoInfo']",
    "[class*='RelatedVideos']",
    "[class*='EndScreen']", "[class*='Endscreen']",
    ".media-item-thumbnail-container",
    "button[aria-label='Copy link']", "button[aria-label='Share']",
    "button[aria-label='More videos']",
    // Classic player, in case YouTube serves it.
    ".ytp-chrome-top", ".ytp-title", ".ytp-title-channel", ".ytp-youtube-button",
    ".ytp-impression-link", ".ytp-watermark", ".ytp-pause-overlay", ".ytp-endscreen-content",
    ".html5-endscreen", ".ytp-ce-element", ".ytp-cards-button", ".ytp-cards-teaser",
    ".ytp-copylink-button", ".ytp-share-button", ".ytp-watch-later-button",
    ".ytp-overflow-button", ".ytp-more-videos-view", ".ytp-suggested-action", ".iv-branding",
  ];
  const style = document.createElement("style");
  style.dataset.pacifier = "";   // marker, so tests can tell our filter from YouTube's own CSS
  style.textContent = HIDE.join(",\n") + " { display: none !important; }";
  (document.head || document.documentElement).append(style);
})();
