// Drives a youtube-nocookie embed over postMessage. This is the same
// protocol YouTube's IFrame API script uses underneath; extensions may not
// load that remote script, so we speak it directly.

export const ORIGIN = "https://www.youtube-nocookie.com";
export const State = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

export class EmbedPlayer {
  constructor(container, videoId, { onState, onProgress, onError } = {}) {
    this.onState = onState;
    this.onProgress = onProgress;
    this.onError = onError;
    this.state = State.UNSTARTED;
    this.currentTime = 0;
    this.duration = 0;
    this.ready = false;
    this.muted = false;

    const params = new URLSearchParams({
      // controls=0: YouTube draws no control bar (and so no "More videos",
      // copy-link or logo links); the portal provides its own controls.
      enablejsapi: "1", autoplay: "0", controls: "0", disablekb: "1", rel: "0",
      // No `origin` parameter: it would put the extension's ID in the URL,
      // and from there in every request path and Referer the embed makes.
      iv_load_policy: "3", fs: "0", playsinline: "1", cc_load_policy: "0",
    });
    this.iframe = document.createElement("iframe");
    // Credentialless: the embed runs in a temporary, empty cookie jar, so
    // nothing it loads (youtube, google, googlevideo, ytimg) can see the
    // browser's real cookies. Must be set before the src.
    this.iframe.credentialless = true;
    this.iframe.setAttribute("credentialless", "");
    // no-referrer hides this page's origin (and so the extension ID) from
    // the embed's location.ancestorOrigins and document.referrer. The
    // Referer YouTube requires is set by the tab's network rules (net.js).
    this.iframe.referrerPolicy = "no-referrer";
    this.iframe.src = `${ORIGIN}/embed/${encodeURIComponent(videoId)}?${params}`;
    this.iframe.allow = "autoplay; encrypted-media; picture-in-picture";
    this.iframe.title = "Video player";
    this.iframe.addEventListener("load", () => this._announce());
    container.append(this.iframe);

    this._onMessage = e => this._receive(e);
    window.addEventListener("message", this._onMessage);
  }

  // The player only starts reporting once the parent says it is listening.
  _announce() {
    clearInterval(this._timer);
    let tries = 0;
    const say = () => {
      if (this.ready || tries++ > 40) { clearInterval(this._timer); return; }
      this._post({ event: "listening" });
    };
    say();
    this._timer = setInterval(say, 250);
  }

  _post(msg) {
    this.iframe.contentWindow?.postMessage(JSON.stringify({ ...msg, id: 1, channel: "widget" }), ORIGIN);
  }

  _command(func, args = []) { this._post({ event: "command", func, args }); }

  _receive(e) {
    if (e.origin !== ORIGIN || e.source !== this.iframe.contentWindow) return;
    let d;
    try { d = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!d || typeof d !== "object") return;

    if (!this.ready && (d.event === "onReady" || d.event === "initialDelivery" || d.event === "infoDelivery")) {
      this.ready = true;
      clearInterval(this._timer);
      this._command("addEventListener", ["onStateChange"]);
      this._command("addEventListener", ["onError"]);
    }
    if (d.event === "infoDelivery" || d.event === "initialDelivery") {
      const i = d.info || {};
      if (typeof i.currentTime === "number") this.currentTime = i.currentTime;
      if (typeof i.duration === "number" && i.duration > 0) this.duration = i.duration;
      if (typeof i.muted === "boolean") this.muted = i.muted;
      if (typeof i.playerState === "number") this._setState(i.playerState);
      this.onProgress?.(this.currentTime, this.duration);
    } else if (d.event === "onStateChange" && typeof d.info === "number") {
      this._setState(d.info);
    } else if (d.event === "onError") {
      this.onError?.(d.info);
    }
  }

  _setState(s) {
    if (s === this.state) return;
    this.state = s;
    this.onState?.(s);
  }

  play() { this._command("playVideo"); }
  pause() { this._command("pauseVideo"); }
  seekTo(seconds) { this._command("seekTo", [seconds, true]); }
  mute() { this._command("mute"); this.muted = true; }
  unMute() { this._command("unMute"); this.muted = false; }
  captions(on) { this._command(on ? "loadModule" : "unloadModule", ["captions"]); }

  destroy() {
    clearInterval(this._timer);
    window.removeEventListener("message", this._onMessage);
    this.iframe.remove();
  }
}
