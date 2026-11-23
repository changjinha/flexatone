"""Static dev server for Flexatone with caching disabled (so edited ES modules always reload).
Same as `python3 -m http.server 8000`, plus `Cache-Control: no-store`.
"""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    http.server.ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
