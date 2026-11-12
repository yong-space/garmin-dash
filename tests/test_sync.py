import json
import os
import tempfile
import threading
import time
import unittest
from datetime import date

from api.metrics import daily_metrics
from sync.backfill import chunks, history_start, missing_ranges, refresh, store_activities, store_daily, sync, tidy
from sync.cache import load_cache, locked, save_cache, slim
from tests.test_api import CACHE, run
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

from sync import client
from sync.client import Garmin, GarminError, Throttle, with_retries


class FakeGarmin:
    """Records requested ranges; returns one item per day for the per-day sources."""

    def __init__(self):
        self.calls = []

    def profile_settings(self):
        return {"measurementSystem": "metric"}

    def _daily(self, name, start, end, item):
        self.calls.append((name, start, end))
        return [dict(item, calendarDate=d.isoformat()) for d in _days(start, end)]

    def activities(self, start, end):
        self.calls.append(("activities", start, end))
        return [{"activityId": 1, "startTimeLocal": f"{start.isoformat()} 07:00:00", "distance": 5000,
                 "activityType": {"typeKey": "running"}}]

    def sleep(self, start, end):
        return self._daily("sleep", start, end, {"sleepTimeSeconds": 25000})

    def hrv(self, start, end):
        return self._daily("hrv", start, end, {"lastNightAvg": 45})

    def daily_summaries(self, start, end):
        return self._daily("summaries", start, end, {"heartRate": {"restingValue": 52}})

    def weight(self, start, end):
        return self._daily("weight", start, end, {"weight": 72000, "bodyFat": 18.0})


def _days(start, end):
    d = start
    while d <= end:
        yield d
        d = date.fromordinal(d.toordinal() + 1)


class BackfillTest(unittest.TestCase):
    def test_missing_ranges_skips_cached_days_but_refreshes_recent_ones(self):
        cached = {"2026-01-02": None, "2026-01-03": None, "2026-01-05": None}
        ranges = missing_ranges(cached, date(2026, 1, 1), date(2026, 1, 5), refresh_from=date(2026, 1, 5))
        self.assertEqual(ranges, [[date(2026, 1, 1), date(2026, 1, 1)], [date(2026, 1, 4), date(2026, 1, 5)]])

    def test_history_start_is_the_monday_before_a_five_year_window(self):
        self.assertEqual(history_start(date(2026, 11, 8)), date(2021, 11, 8))  # window starts Tue Nov 9; its Monday
        self.assertEqual(history_start(date(2024, 2, 29)), date(2019, 2, 25))  # Feb 28 clamped, +1 = Fri Mar 1; its Monday
        self.assertEqual(history_start(date(2026, 2, 9)).weekday(), 0)
        self.assertEqual(history_start(date(2026, 11, 8), months=12), date(2025, 11, 3))

    def test_chunks_run_newest_first_and_cover_the_range(self):
        self.assertEqual(list(chunks(date(2026, 1, 1), date(2026, 3, 1), 30)),
                         [(date(2026, 1, 31), date(2026, 3, 1)), (date(2026, 1, 1), date(2026, 1, 30))])
        self.assertEqual(list(chunks(date(2026, 1, 1), date(2026, 1, 1), 30)), [(date(2026, 1, 1), date(2026, 1, 1))])

    def test_sync_fills_cache_and_second_run_only_refetches_recent_days(self):
        api, cache = FakeGarmin(), load_cache("/nonexistent/cache.json")
        start, end = date(2026, 1, 1), date(2026, 3, 1)
        sync(api, cache, start, end, log=lambda m: None)
        self.assertEqual(len(cache["sleep"]), 60)
        self.assertEqual(cache["activities"]["2026-01-01"][0]["activityId"], 1)
        # sleep is chunked to 30 days per request, newest first
        sleep_calls = [c for c in api.calls if c[0] == "sleep"]
        self.assertEqual([c[1:] for c in sleep_calls],
                         [(date(2026, 1, 31), date(2026, 3, 1)), (date(2026, 1, 1), date(2026, 1, 30))])

        api.calls.clear()
        sync(api, cache, start, end, log=lambda m: None)
        self.assertTrue(all(c[1] == date(2026, 2, 28) for c in api.calls), api.calls)  # just the last two days

    def test_chunks_are_fetched_newest_first_across_sources(self):
        api, cache = FakeGarmin(), load_cache("/nonexistent/cache.json")
        sync(api, cache, date(2025, 1, 1), date(2026, 3, 1), log=lambda m: None)
        ends = [c[2] for c in api.calls]
        self.assertEqual(ends, sorted(ends, reverse=True))
        self.assertEqual({c[0] for c in api.calls[:5]}, {"activities", "sleep", "hrv", "summaries", "weight"})

    def test_refetch_activities_drops_and_refetches_just_that_range(self):
        api, cache = FakeGarmin(), load_cache("/nonexistent/cache.json")
        start, end = date(2026, 1, 1), date(2026, 3, 1)
        sync(api, cache, start, end, log=lambda m: None)
        cache["activities"]["2026-01-10"] = [{"activityId": 9, "eventType": {"typeKey": "uncategorized"}}]
        cache["sleep"]["2026-01-10"] = {"sleepTimeSeconds": 1}

        api.calls.clear()
        sync(api, cache, start, end, log=lambda m: None, refetch_activities=(date(2026, 1, 10), date(2026, 1, 11)))
        self.assertIn(("activities", date(2026, 1, 10), date(2026, 1, 11)), api.calls)
        self.assertFalse([c for c in api.calls if c[0] != "activities" and c[1] < date(2026, 2, 28)])  # only activities
        self.assertEqual(cache["activities"]["2026-01-10"][0]["activityId"], 1)  # the stale entry is replaced
        self.assertEqual(cache["activities"]["2026-01-11"], [])
        self.assertEqual(cache["sleep"]["2026-01-10"], {"sleepTimeSeconds": 1})  # other sources untouched

    def test_saves_after_every_chunk(self):
        api, cache = FakeGarmin(), load_cache("/nonexistent/cache.json")
        saves = []
        sync(api, cache, date(2026, 1, 1), date(2026, 3, 1), log=lambda m: None, save=lambda: saves.append(1))
        self.assertEqual(len(saves), len(api.calls))

    def test_a_failed_chunk_leaves_its_days_unfetched(self):
        class Broken(FakeGarmin):
            def sleep(self, start, end):
                if start < date(2026, 1, 31):
                    raise GarminError("GET sleep failed: 500", 500)
                return super().sleep(start, end)

        cache = load_cache("/nonexistent/cache.json")
        with self.assertRaises(GarminError):
            sync(Broken(), cache, date(2026, 1, 1), date(2026, 3, 1), log=lambda m: None)
        self.assertEqual(min(cache["sleep"]), "2026-01-31")  # the newer chunk is kept, the failed one not marked

    def test_saves_leave_no_temp_files_and_concurrent_writers_cannot_corrupt(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "cache.json")
            caches = [{"sleep": {f"2026-01-{d:02d}": {"sleepTimeSeconds": i} for d in range(1, 29)}} for i in range(8)]
            threads = [threading.Thread(target=save_cache, args=(path, c)) for c in caches for _ in range(5)]
            [t.start() for t in threads]
            [t.join() for t in threads]
            self.assertIn(load_cache(path)["sleep"], [c["sleep"] for c in caches])  # one whole writer's file
            self.assertEqual(os.listdir(tmp), ["cache.json"])
            self.assertEqual(oct(os.stat(path).st_mode & 0o777), "0o644")

    def test_cache_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "cache.json")
            save_cache(path, {"sleep": {"2026-01-01": None}})
            cache = load_cache(path)
            self.assertEqual(cache["sleep"], {"2026-01-01": None})
            self.assertEqual(cache["hrv"], {})


class RefreshTest(unittest.TestCase):
    def test_refresh_writes_the_history_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "cache.json")
            refresh(path, FakeGarmin(), date(2026, 3, 1), log=lambda m: None)
            hrv = load_cache(path)["hrv"]
            self.assertEqual(min(hrv), "2021-03-01")  # Monday of the week containing 2021-03-02
            self.assertEqual(max(hrv), "2026-03-01")

    def test_refresh_refetches_activities_in_the_given_range(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "cache.json")
            refresh(path, FakeGarmin(), date(2026, 3, 1), log=lambda m: None)
            cache = load_cache(path)
            cache["activities"]["2025-06-01"] = [{"activityId": 9}]
            save_cache(path, cache)

            api = FakeGarmin()
            refresh(path, api, date(2026, 3, 1), log=lambda m: None,
                    refetch_activities=(date(2025, 6, 1), date(2025, 6, 1)))
            self.assertIn(("activities", date(2025, 6, 1), date(2025, 6, 1)), api.calls)
            self.assertEqual(load_cache(path)["activities"]["2025-06-01"][0]["activityId"], 1)

    def test_failed_refresh_keeps_completed_chunks_and_the_next_run_resumes(self):
        class Broken(FakeGarmin):
            def sleep(self, start, end):
                if start < date(2025, 1, 1):
                    raise GarminError("GET sleep failed: 429", 429)
                return super().sleep(start, end)

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "cache.json")
            with self.assertRaises(GarminError):
                refresh(path, Broken(), date(2026, 3, 1), log=lambda m: None)
            saved = load_cache(path)
            self.assertEqual(max(saved["sleep"]), "2026-03-01")
            self.assertGreater(min(saved["sleep"]), "2024-12-01")  # stopped at the first failing chunk
            self.assertIn("2025-01-01", saved["activities"])  # newer chunks of other sources were saved too

            api = FakeGarmin()
            refresh(path, api, date(2026, 3, 1), log=lambda m: None)
            self.assertEqual(min(load_cache(path)["sleep"]), "2021-03-01")
            kept = date.fromisoformat(min(saved["sleep"]))
            refetched = [c[1:] for c in api.calls if c[0] == "sleep" and c[2] >= kept]
            self.assertEqual(refetched, [(date(2026, 2, 28), date(2026, 3, 1))])  # of the saved days, only the refresh

    def test_lock_makes_a_second_writer_wait(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "cache.json")
            events = []

            def second():
                with locked(path):
                    events.append("second")

            with locked(path):
                t = threading.Thread(target=second)
                t.start()
                time.sleep(0.2)
                events.append("first done")
            t.join()
            self.assertEqual(events, ["first done", "second"])


def raw(item, **extra):
    """`item` as Garmin would send it: with fields the dashboard doesn't use."""
    return dict(item, junkField="x" * 50, junkNested={"a": 1, "b": [1, 2, 3]}, nullField=None, **extra)


class SlimTest(unittest.TestCase):
    def test_keeps_only_listed_paths(self):
        sleep = raw({"sleepTimeSeconds": 25200, "napTimeSeconds": 600,
                     "sleepScores": {"overall": {"value": 80, "qualifierKey": "GOOD"}, "rem": {"value": 70}}})
        self.assertEqual(slim("sleep", sleep), {"sleepTimeSeconds": 25200, "sleepScores": {"overall": {"value": 80}}})

    def test_lists_nulls_and_empty_branches(self):
        act = raw({"activityId": 7, "distance": None, "eventType": None, "activityType": {"typeKey": "running", "typeId": 1},
                   "splitSummaries": [{"splitType": "RWD_RUN", "distance": 1}, {"splitType": "INTERVAL_REST"}]})
        self.assertEqual(slim("activities", act), {
            "activityId": 7, "activityType": {"typeKey": "running"},
            "splitSummaries": [{"splitType": "RWD_RUN"}, {"splitType": "INTERVAL_REST"}],
        })
        self.assertEqual(slim("sleep", {"sleepScores": {"overall": {"value": None}}}), {})
        self.assertIsNone(slim("hrv", None))

    def test_is_idempotent(self):
        once = slim("activities", raw(run(10.5, [25, 20, 15, 30, 10], ["INTERVAL_WARMUP"]), activityId=1))
        self.assertEqual(slim("activities", once), once)

    def test_api_output_is_unchanged_by_slimming(self):
        """The contract: KEEP covers every field api/metrics.py reads."""
        acts = [raw(run(8, [20, 70, 10, 0, 0]), startTimeLocal="2026-01-02 07:00:00", activityId=1),
                raw(dict(run(21.1, [0, 5, 30, 60, 5]), eventType={"typeKey": "race"}, activityName="Half", duration=5400),
                    startTimeLocal="2026-01-02 09:00:00", activityId=2),
                raw({"activityType": {"typeKey": "strength_training"}, "duration": 1800},
                    startTimeLocal="2026-01-03 18:00:00", activityId=3),
                # typed only by its splits (intervals), and only by its HR zones (tempo)
                raw(run(7, [30, 30, 39, 1, 0], ["INTERVAL_REST"]), startTimeLocal="2026-01-04 07:00:00", activityId=4),
                raw(run(10, [5, 15, 75, 5, 0]), startTimeLocal="2026-01-04 18:00:00", activityId=5)]
        full = json.loads(json.dumps(CACHE))
        full["profile"] = raw({"measurementSystem": "statute_us", "displayName": "me"})
        full["activities"] = {"2026-01-02": acts[:2], "2026-01-03": acts[2:3], "2026-01-04": acts[3:]}
        for source in ("sleep", "hrv", "summaries", "weight"):
            full[source] = {day: raw(v) if v else v for day, v in full[source].items()}
        slimmed = json.loads(json.dumps(full))
        slimmed["profile"] = slim("profile", slimmed["profile"])
        tidy(slimmed, date(2025, 12, 1))
        self.assertEqual(daily_metrics(slimmed, date(2026, 1, 1), date(2026, 1, 4)),
                         daily_metrics(full, date(2026, 1, 1), date(2026, 1, 4)))


class StoreTest(unittest.TestCase):
    def test_activities_are_stored_slim_in_start_order(self):
        cache = {"activities": {}}
        newest_first = [raw({"activityId": 2, "distance": 5000}, startTimeLocal="2026-01-02 18:00:00"),
                        raw({"activityId": 1, "distance": 3000}, startTimeLocal="2026-01-02 07:00:00")]
        store_activities(cache, date(2026, 1, 1), date(2026, 1, 2), newest_first)
        self.assertEqual(cache["activities"], {"2026-01-01": [], "2026-01-02": [{"activityId": 1, "distance": 3000},
                                                                                {"activityId": 2, "distance": 5000}]})

    def test_items_without_a_date_are_skipped(self):
        cache = {"sleep": {}}
        store_daily("sleep")(cache, date(2026, 1, 1), date(2026, 1, 1),
                             [{"calendarDate": None, "sleepTimeSeconds": None},
                              raw({"calendarDate": "2026-01-01", "sleepTimeSeconds": 100})])
        self.assertEqual(cache["sleep"], {"2026-01-01": {"sleepTimeSeconds": 100}})

    def test_tidy_drops_days_outside_the_window_and_converts_an_old_cache(self):
        cache = load_cache("/nonexistent/cache.json")
        cache["sleep"] = {"2020-12-31": raw({"sleepTimeSeconds": 1}), "null": {"calendarDate": None},
                          "2021-01-01": raw({"sleepTimeSeconds": 2}), "2021-01-02": None}
        cache["activities"] = {"2021-01-01": [raw({"activityId": 2}, startTimeLocal="2021-01-01 18:00:00"),
                                              raw({"activityId": 1}, startTimeLocal="2021-01-01 07:00:00")]}
        tidy(cache, date(2021, 1, 1))
        self.assertEqual(cache["sleep"], {"2021-01-01": {"sleepTimeSeconds": 2}, "2021-01-02": None})
        self.assertEqual(cache["activities"], {"2021-01-01": [{"activityId": 1}, {"activityId": 2}]})


class RetryTest(unittest.TestCase):
    def setUp(self):
        self.waits = []

    def call(self, failures, attempts=4):
        """with_retries over a function that raises each of `failures` in turn, then returns "ok"."""
        failures = list(failures)

        def fn():
            if failures:
                raise failures.pop(0)
            return "ok"

        return with_retries(fn, "GET x", log=lambda m: None, sleep=self.waits.append, attempts=attempts, base=10, cap=60)

    def test_transient_failures_back_off_exponentially(self):
        errors = [GarminError("x", 429), GarminError("x", 503), GarminError("network down")]
        self.assertEqual(self.call(errors), "ok")
        self.assertEqual(self.waits, [10, 20, 40])

    def test_backoff_is_capped_and_honours_retry_after(self):
        self.assertEqual(self.call([GarminError("x", 429, retry_after=45), GarminError("x", 500),
                                    GarminError("x", 500)], attempts=5), "ok")
        self.assertEqual(self.waits, [45, 20, 40])
        self.waits.clear()
        self.call([GarminError("x", 429, retry_after=3600)])
        self.assertEqual(self.waits, [60])

    def test_gives_up_after_the_last_attempt(self):
        with self.assertRaises(GarminError):
            self.call([GarminError("x", 500)] * 4)
        self.assertEqual(self.waits, [10, 20, 40])

    def test_client_errors_are_not_retried(self):
        for status in (400, 401, 403, 404):
            with self.assertRaises(GarminError):
                self.call([GarminError("x", status)])
        self.assertEqual(self.waits, [])
        with self.assertRaises(ValueError):  # nor are bugs
            with_retries(lambda: int("x"), "parse", log=lambda m: None, sleep=self.waits.append)

    def test_throttle_spaces_calls(self):
        now = [100.0]
        waits = []

        def sleep(s):
            waits.append(s)
            now[0] += s

        throttle = Throttle(2.0, sleep=sleep, clock=lambda: now[0])
        throttle.wait()  # first call: no wait
        now[0] += 0.5
        throttle.wait()  # 0.5s later: waits the remaining 1.5s
        now[0] += 5
        throttle.wait()  # long after: no wait
        self.assertEqual(waits, [1.5])


class ClientTest(unittest.TestCase):
    """The real client against a local server that answers each request from a script of (status, body)."""

    def serve(self, script):
        seen = self.seen = []

        class Handler(BaseHTTPRequestHandler):
            def respond(self):
                seen.append((self.command, self.path))
                status, body = script.pop(0)
                data = json.dumps(body).encode() if not isinstance(body, str) else body.encode()
                self.send_response(status)
                if status == 429:
                    self.send_header("Retry-After", "7")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = respond

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        patcher = mock.patch.object(client, "BASE_URL", f"http://127.0.0.1:{server.server_address[1]}")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_rate_limited_request_is_retried_after_retry_after(self):
        self.serve([(200, "tok"), (429, {}), (200, [{"calendarDate": "2026-01-01"}])])
        waits = []
        api = Garmin("key", log=lambda m: None, sleep=waits.append)
        self.assertEqual(api.token, "tok")
        self.assertEqual(api.sleep(date(2026, 1, 1), date(2026, 1, 1)), [{"calendarDate": "2026-01-01"}])
        self.assertEqual(len(self.seen), 3)
        self.assertIn(10, waits)  # max(first backoff, Retry-After 7)

    def test_client_error_fails_at_once(self):
        self.serve([(200, "tok"), (401, {"error": "bad token"})])
        api = Garmin("key", log=lambda m: None, sleep=lambda s: None)
        with self.assertRaises(GarminError) as ctx:
            api.hrv(date(2026, 1, 1), date(2026, 1, 1))
        self.assertEqual(ctx.exception.status, 401)
        self.assertEqual(len(self.seen), 2)


if __name__ == "__main__":
    unittest.main()
