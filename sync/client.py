"""Garmin Connect Personal API client: auth plus one method per data source."""

import base64
import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://personal.connectapi.garmin.com"
TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"

REQUEST_DELAY = 2.0  # seconds between the starts of two requests, so a long backfill doesn't trip rate limiting
MAX_ATTEMPTS = 6  # per request: the first try plus up to 5 retries
BACKOFF_BASE = 10.0  # seconds before the first retry; doubles each time (10, 20, 40, 80, 160)
BACKOFF_MAX = 300.0  # cap on one wait, including a server's Retry-After


class GarminError(Exception):
    """A failed request. status is the HTTP status, or None if the request never got a response."""

    def __init__(self, message, status=None, retry_after=None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after  # seconds, from a Retry-After header

    @property
    def transient(self):
        """Worth retrying: rate limited (429), a server error (5xx) or a network failure."""
        return self.status is None or self.status == 429 or self.status >= 500


def _retry_after(headers):
    try:
        return float(headers.get("Retry-After"))
    except (TypeError, ValueError):
        return None  # absent, or an HTTP date (rare; the backoff covers it)


def _open(req, what, timeout):
    """The response body of `req`, or GarminError (with the status) on any failure."""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        raise GarminError(f"{what} failed: {e.code} {e.read().decode(errors='replace')[:200]}",
                          e.code, _retry_after(e.headers)) from e
    except OSError as e:  # URLError, timeouts, connection resets
        raise GarminError(f"{what} failed: {e}") from e


def with_retries(fn, what, log=print, sleep=time.sleep,
                 attempts=MAX_ATTEMPTS, base=BACKOFF_BASE, cap=BACKOFF_MAX):
    """fn(), retrying transient GarminErrors with exponential backoff; anything else, or the last failure, raises."""
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except GarminError as e:
            if not e.transient or attempt == attempts:
                raise
            wait = min(cap, max(base * 2 ** (attempt - 1), e.retry_after or 0))
            log(f"{what}: {e}; retry {attempt}/{attempts - 1} in {wait:g}s")
            sleep(wait)


class Throttle:
    """Spaces calls to wait() at least `interval` seconds apart."""

    def __init__(self, interval, sleep=time.sleep, clock=time.monotonic):
        self.interval, self.sleep, self.clock = interval, sleep, clock
        self.last = None

    def wait(self):
        if self.last is not None:
            remaining = self.last + self.interval - self.clock()
            if remaining > 0:
                self.sleep(remaining)
        self.last = self.clock()


def read_api_key():
    """GARMIN_PERSONAL_API_KEY if set, else the `garmin-key` k8s secret via kubectl."""
    if os.environ.get("GARMIN_PERSONAL_API_KEY"):
        return os.environ["GARMIN_PERSONAL_API_KEY"].strip()
    raw = subprocess.check_output(
        ["kubectl", "get", "secret", "garmin-key", "-o", "jsonpath={.data.GARMIN_KEY}"]
    )
    return base64.b64decode(raw).decode().strip()


class Garmin:
    """Every request is paced (REQUEST_DELAY apart) and retried with backoff when the failure is transient."""

    def __init__(self, api_key, log=print, sleep=time.sleep):
        self._log, self._pause = log, sleep  # not self.sleep: that's the sleep-data method below
        self._throttle = Throttle(REQUEST_DELAY, sleep)
        req = urllib.request.Request(
            BASE_URL + TOKEN_PATH,
            method="POST",
            headers={"Accept": "*/*", "Authorization": f"ApiKey {api_key}"},
        )
        self.token = self._request(req, "token exchange", timeout=30).decode().strip()

    def _request(self, req, what, timeout):
        def attempt():
            self._throttle.wait()
            return _open(req, what, timeout)
        return with_retries(attempt, what, self._log, self._pause)

    def get(self, path, params=None):
        url = BASE_URL + path + ("?" + urllib.parse.urlencode(params) if params else "")
        req = urllib.request.Request(
            url, headers={"Accept": "application/json", "Authorization": f"Bearer {self.token}"}
        )
        body = self._request(req, f"GET {path}", timeout=60)
        return json.loads(body) if body else None

    def profile_settings(self):
        return self.get("/userprofile-service/userprofile/settings") or {}

    def activities(self, start, end):
        out, offset = [], 0
        while True:
            page = self.get(
                "/activitylist-service/activities/search/activities",
                {"start": offset, "limit": 100, "startDate": start.isoformat(), "endDate": end.isoformat()},
            ) or []
            out += page
            if len(page) < 100:
                return out
            offset += 100

    def sleep(self, start, end):
        return self.get(
            "/sleep-service/sleep/dailySleepSummariesByDate",
            {"startDate": start.isoformat(), "endDate": end.isoformat()},
        ) or []

    def hrv(self, start, end):
        data = self.get(f"/hrv-service/hrv/daily/{start.isoformat()}/{end.isoformat()}") or {}
        return data.get("hrvSummaries") or []

    def daily_summaries(self, start, end):
        data = self.get(
            "/usersummary-service/v2/dailysummaries",
            {"startDate": start.isoformat(), "endDate": end.isoformat()},
        ) or {}
        return data.get("data") or []

    def weight(self, start, end):
        """One {calendarDate, weight (grams), bodyFat (%)} per day, from that day's latest reading."""
        data = self.get(
            f"/weight-service/weight/range/{start.isoformat()}/{end.isoformat()}", {"includeAll": "true"}
        ) or {}
        out = []
        for day in data.get("dailyWeightSummaries") or []:
            readings = day.get("allWeightMetrics") or [day.get("latestWeight") or {}]
            latest = max(readings, key=lambda m: m.get("timestampGMT") or 0)
            out.append({"calendarDate": day["summaryDate"], "weight": latest.get("weight"), "bodyFat": latest.get("bodyFat")})
        return out
