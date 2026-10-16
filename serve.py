"""Serve the portal on http://127.0.0.1:8765 — local only.

Only the portal files and the current feed are reachable; everything else is
404. The Content-Security-Policy is the backstop for the distraction-free
rules: no third-party scripts, styles or images beyond the YouTube player."""

import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOST, PORT = "127.0.0.1", int(os.environ.get("PACIFIER_PORT", "8765"))

ROUTES = {
    "/": (ROOT / "portal" / "index.html", "text/html; charset=utf-8"),
    "/app.js": (ROOT / "portal" / "app.js", "text/javascript; charset=utf-8"),
    "/style.css": (ROOT / "portal" / "style.css", "text/css; charset=utf-8"),
    "/feed.json": (ROOT / "data" / "feed.json", "application/json; charset=utf-8"),
}

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self' https://www.youtube.com",
    "frame-src https://www.youtube-nocookie.com",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
])


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        route = ROUTES.get(path)
        if not route or not route[0].exists():
            self.send_error(404)
            return
        body = route[0].read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", route[1])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Security-Policy", CSP)
        # The YouTube embed refuses to play without a referrer (error 153).
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"Pacifier on http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
