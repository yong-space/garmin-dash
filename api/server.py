"""Read-only HTTP API over the cache file.

    GET /api/health                              200 once a cache exists, else 503
    GET /api/days?start=YYYY-MM-DD&end=YYYY-MM-DD   per-day metrics (see metrics.daily_metrics), with the
                                                 lactate threshold CSV's values if that file exists

With --static DIR it also serves that directory (the frontend, web/) at /, so one process serves the whole app.
"""

import json
import os
import threading
from datetime import date, datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from .metrics import daily_metrics, parse_thresholds

MAX_DAYS = 5 * 366 + 6  # longest range one request may ask for: five years, plus the reach back to a Monday


class CacheFile:
    """The parsed cache, re-read whenever a sync replaces the file."""

    def __init__(self, path):
        self.path = path
        self._mtime = None
        self._cache = None
        self._lock = threading.Lock()

    def get(self):
        """(cache, mtime) or (None, None) if there is no cache yet."""
        try:
            mtime = os.stat(self.path).st_mtime
        except FileNotFoundError:
            return None, None
        with self._lock:
            if mtime != self._mtime:
                # release the old copy before parsing the new one, so the two are never in memory together
                self._cache = self._mtime = None
                with open(self.path) as f:
                    self._cache = json.load(f)
                self._mtime = mtime
            return self._cache, self._mtime


class ThresholdsFile:
    """The lactate threshold CSV (see metrics.parse_thresholds), re-read whenever it changes. It's optional: a
    missing file means no thresholds. Rows that don't parse are skipped and logged."""

    def __init__(self, path):
        self.path = path
        self._mtime = None
        self._rows = []
        self._lock = threading.Lock()

    def get(self):
        try:
            mtime = os.stat(self.path).st_mtime
        except FileNotFoundError:
            return []
        with self._lock:
            if mtime != self._mtime:
                with open(self.path, newline="") as f:
                    self._rows, problems = parse_thresholds(f.read())
                self._mtime = mtime
                for p in problems:
                    print(f"{self.path}: skipped {p}", flush=True)
            return self._rows


class BadRequest(Exception):
    pass


def parse_range(query):
    params = parse_qs(query)
    try:
        start, end = (date.fromisoformat(params[k][0]) for k in ("start", "end"))
    except (KeyError, ValueError):
        raise BadRequest("start and end are required, as YYYY-MM-DD")
    if start > end:
        raise BadRequest("start is after end")
    if (end - start).days + 1 > MAX_DAYS:
        raise BadRequest(f"range is longer than {MAX_DAYS} days")
    return start, end


class Handler(SimpleHTTPRequestHandler):
    cache_file = None  # set by make_server
    thresholds_file = None
    static_dir = None
    # Keep-alive, so the proxy reuses connections instead of opening one per file (HTTP/1.0 closes after each
    # response). Every response carries a Content-Length. Idle connections close after `timeout` seconds, so
    # they don't hold a thread each indefinitely.
    protocol_version = "HTTP/1.1"
    timeout = 30

    def _json(self, code, body):
        data = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")  # static files: revalidate so edits show up
        super().end_headers()

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/api/health":
            cache, mtime = self.cache_file.get()
            if cache is None:
                return self._json(503, {"ok": False, "error": "no cache yet"})
            updated = datetime.fromtimestamp(mtime, timezone.utc).isoformat(timespec="seconds")
            return self._json(200, {"ok": True, "cache_updated": updated})
        if url.path == "/api/days":
            try:
                start, end = parse_range(url.query)
            except BadRequest as e:
                return self._json(400, {"error": str(e)})
            cache, _ = self.cache_file.get()
            if cache is None:
                return self._json(503, {"error": "no cache yet"})
            return self._json(200, daily_metrics(cache, start, end, self.thresholds_file.get()))
        if url.path.startswith("/api/") or not self.static_dir:
            return self._json(404, {"error": "not found"})
        super().do_GET()

    def do_HEAD(self):
        if self.static_dir and not self.path.startswith("/api/"):
            return super().do_HEAD()
        self.send_error(405)

    def list_directory(self, path):  # static files only, no directory listings
        self.send_error(404)

    def log_message(self, fmt, *args):
        pass


class Server(ThreadingHTTPServer):
    # The listen backlog. socketserver's default is 5: a page load requests ~16 files at once, the kernel dropped
    # the connections that didn't fit, and the proxy retried them after 0.2-1s (TCP retransmission).
    request_queue_size = 128


def make_server(cache_path, host, port, static_dir=None, thresholds_path="lactate_threshold.csv"):
    handler = type("BoundHandler", (Handler,), {"cache_file": CacheFile(cache_path), "static_dir": static_dir,
                                                "thresholds_file": ThresholdsFile(thresholds_path)})
    if static_dir:
        handler = partial(handler, directory=static_dir)
    return Server((host, port), handler)
