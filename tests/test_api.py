import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import date

from api.metrics import daily_metrics, parse_thresholds, recent_longest, run_type
from api.server import make_server

CACHE = {
    "profile": {"measurementSystem": "metric"},
    "activities": {
        "2026-01-02": [
            {"activityType": {"typeKey": "running"}, "distance": 10000, "duration": 3000,
             "eventType": {"typeKey": "race"}, "activityName": "City 10K"},
            {"activityType": {"typeKey": "trail_running"}, "distance": 2500},
        ],
        "2026-01-03": [{"activityType": {"typeKey": "strength_training"}, "duration": 1800}],
    },
    "sleep": {"2026-01-02": {"sleepTimeSeconds": 25200, "sleepScores": {"overall": {"value": 80}}}},
    "hrv": {"2026-01-02": {"lastNightAvg": 45}, "2026-01-03": None},
    "summaries": {"2026-01-03": {"heartRate": {"restingValue": 52}}},
    "weight": {
        "2025-12-30": {"weight": 72000.0, "bodyFat": 18.0},
        "2026-01-03": {"weight": 71500.0, "bodyFat": None},
    },
}


class MetricsTest(unittest.TestCase):
    def test_daily_metrics(self):
        d = daily_metrics(CACHE, date(2026, 1, 1), date(2026, 1, 4))
        m = d["metrics"]
        self.assertEqual(d["units"], {"distance": "km", "weight": "kg"})
        self.assertEqual(m["run_dist"], {"2026-01-02": 12.5})
        self.assertEqual(m["strength_mins"], {"2026-01-03": 30.0})
        self.assertEqual(m["sleep_secs"], {"2026-01-02": 25200})
        self.assertEqual(m["sleep_score"], {"2026-01-02": 80})
        self.assertEqual(m["hrv"], {"2026-01-02": 45})
        self.assertEqual(m["rhr"], {"2026-01-03": 52})
        self.assertEqual(d["races"], {"2026-01-02": [{"name": "City 10K", "distance": 10.0, "duration": 3000}]})

    def test_weight_carries_forward_from_before_the_range(self):
        m = daily_metrics(CACHE, date(2026, 1, 1), date(2026, 1, 4))["metrics"]
        self.assertEqual(m["weight"], {"2026-01-01": 72.0, "2026-01-02": 72.0, "2026-01-03": 71.5, "2026-01-04": 71.5})
        self.assertEqual(m["body_fat"], {d: 18.0 for d in ("2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04")})

    def test_weighed_on_names_the_day_each_weight_was_measured(self):
        m = daily_metrics(CACHE, date(2026, 1, 1), date(2026, 1, 4))["metrics"]
        self.assertEqual(m["weighed_on"], {"2026-01-01": "2025-12-30", "2026-01-02": "2025-12-30",
                                           "2026-01-03": "2026-01-03", "2026-01-04": "2026-01-03"})

    def test_imperial_units(self):
        cache = dict(CACHE, profile={"measurementSystem": "statute_us"})
        d = daily_metrics(cache, date(2026, 1, 2), date(2026, 1, 2))
        self.assertEqual(d["units"], {"distance": "mi", "weight": "lb"})
        self.assertAlmostEqual(d["metrics"]["run_dist"]["2026-01-02"], 12500 / 1609.344)


LT_CSV = """\
# a comment, then the header
date,heart_rate,pace

2026-01-03,165,4:40
2025-12-20,168,4:45
2026-01-05,abc,4:30
2026-01-06,170,4:6
"""


class LactateThresholdTest(unittest.TestCase):
    def test_parse_sorts_by_date_and_reports_bad_rows(self):
        rows, problems = parse_thresholds(LT_CSV)
        self.assertEqual(rows, [(date(2025, 12, 20), 168, 285), (date(2026, 1, 3), 165, 280)])
        self.assertEqual(len(problems), 2)
        self.assertIn("line 6", problems[0])  # heart rate not a number
        self.assertIn("line 7", problems[1])  # seconds need two digits

    def test_each_day_carries_the_latest_entry_from_before_the_range_too(self):
        rows, _ = parse_thresholds(LT_CSV)
        m = daily_metrics(CACHE, date(2025, 12, 19), date(2026, 1, 4), rows)["metrics"]
        days = [f"2025-12-{d}" for d in range(20, 32)] + ["2026-01-01", "2026-01-02"]
        self.assertNotIn("2025-12-19", m["lt_pace"])  # before the first entry
        self.assertEqual(m["lt_pace"], {**{d: 285 for d in days}, "2026-01-03": 280, "2026-01-04": 280})
        self.assertEqual(m["lt_hr"]["2026-01-02"], 168)
        self.assertEqual(m["lt_hr"]["2026-01-04"], 165)
        self.assertEqual(m["lt_since"]["2026-01-02"], "2025-12-20")
        self.assertEqual(m["lt_since"]["2026-01-04"], "2026-01-03")

        m = daily_metrics(CACHE, date(2026, 1, 4), date(2026, 1, 4), rows)["metrics"]
        self.assertEqual(m["lt_pace"], {"2026-01-04": 280})

    def test_pace_is_per_mile_in_imperial_units(self):
        rows, _ = parse_thresholds(LT_CSV)
        cache = dict(CACHE, profile={"measurementSystem": "statute_us"})
        m = daily_metrics(cache, date(2026, 1, 4), date(2026, 1, 4), rows)["metrics"]
        self.assertAlmostEqual(m["lt_pace"]["2026-01-04"], 280 * 1.609344)

    def test_no_thresholds(self):
        m = daily_metrics(CACHE, date(2026, 1, 1), date(2026, 1, 4))["metrics"]
        self.assertEqual((m["lt_pace"], m["lt_hr"], m["lt_since"]), ({}, {}, {}))


def run(km, zones, splits=()):
    """A running activity: distance, seconds in HR zones 1-5, and split types."""
    a = {"activityType": {"typeKey": "running"}, "distance": km * 1000,
         "splitSummaries": [{"splitType": t} for t in ("RWD_RUN", "INTERVAL_ACTIVE", *splits)]}
    a.update({f"hrTimeInZone_{z}": secs for z, secs in enumerate(zones, 1)})
    return a


class RunTypeTest(unittest.TestCase):
    def test_long_wins_whatever_the_intensity_or_structure(self):
        self.assertEqual(run_type(run(12, [100, 0, 0, 0, 0])), "long")
        self.assertEqual(run_type(run(21.1, [0, 5, 30, 60, 5])), "long")  # a half marathon race
        self.assertEqual(run_type(run(16, [10, 20, 30, 40, 0], ["INTERVAL_WARMUP", "INTERVAL_REST"])), "long")

    def test_long_bar_rises_with_the_longest_recent_run(self):
        self.assertEqual(run_type(run(12, [100, 0, 0, 0, 0]), recent_longest=0), "long")  # nothing to compare: 12 km
        self.assertEqual(run_type(run(12, [100, 0, 0, 0, 0]), recent_longest=16000), "long")  # 12 km > 0.65 x 16 km
        self.assertEqual(run_type(run(12.5, [20, 70, 10, 0, 0]), recent_longest=20000), "base")  # a few days after a 20 km long run
        self.assertEqual(run_type(run(13.5, [20, 70, 10, 0, 0]), recent_longest=20000), "long")  # a cutback-week long run
        self.assertEqual(run_type(run(11.9, [100, 0, 0, 0, 0]), recent_longest=0), "base")  # never below 12 km

    def test_rest_splits_make_intervals_when_any_time_reaches_zone_4(self):
        self.assertEqual(run_type(run(7, [30, 30, 39, 1, 0], ["INTERVAL_REST", "INTERVAL_COOLDOWN"])), "intervals")

    def test_rest_splits_without_zone_4_are_an_easy_structured_run(self):
        easy = run(12.5, [800, 3000, 1000, 0, 0], ["INTERVAL_WARMUP", "INTERVAL_REST"])
        self.assertEqual(run_type(easy, recent_longest=20000), "base")

    def test_rest_splits_without_heart_rate_are_intervals(self):
        self.assertEqual(run_type(run(6.3, [0, 0, 0, 0, 0], ["INTERVAL_REST"])), "intervals")

    def test_structured_workout_with_hard_time_is_intervals(self):
        self.assertEqual(run_type(run(10.5, [25, 20, 15, 30, 10], ["INTERVAL_WARMUP"])), "intervals")
        self.assertEqual(run_type(run(10, [40, 30, 20, 10, 0], ["INTERVAL_WARMUP"])), "base")  # structured but easy

    def test_tempo_and_base_by_zone_mix(self):
        self.assertEqual(run_type(run(10, [5, 15, 75, 5, 0])), "tempo")
        self.assertEqual(run_type(run(8.5, [5, 10, 20, 40, 25])), "tempo")  # threshold counts as tempo
        self.assertEqual(run_type(run(8, [20, 70, 10, 0, 0])), "base")
        self.assertEqual(run_type(run(9, [35, 17, 45, 3, 0])), "base")  # just under half in zones 3-5

    def test_no_heart_rate_is_base(self):
        self.assertEqual(run_type(run(5, [0, 0, 0, 0, 0])), "base")

    def test_daily_metrics_lists_runs_with_types(self):
        cache = {"activities": {"2026-01-02": [run(8, [20, 70, 10, 0, 0]), run(4, [0, 10, 80, 10, 0])]}}
        d = daily_metrics(cache, date(2026, 1, 2), date(2026, 1, 2))
        self.assertEqual(d["runs"], {"2026-01-02": [{"type": "base", "distance": 8.0, "race": False},
                                                    {"type": "tempo", "distance": 4.0, "race": False}]})

    def test_long_run_bar_looks_back_before_the_range_and_skips_races_and_later_runs(self):
        race = dict(run(42.2, [0, 0, 20, 80, 0]), eventType={"typeKey": "race"})
        cache = {"activities": {
            "2025-12-20": [run(30, [100, 0, 0, 0, 0])],  # 29 days before: outside the lookback
            "2025-12-22": [run(20, [100, 0, 0, 0, 0])],  # before the range, inside the lookback
            "2025-12-28": [race],  # races don't raise the bar
            "2026-01-18": [run(12.5, [20, 70, 10, 0, 0])],  # needs 0.65 x 20 = 13 km
            "2026-01-20": [run(13, [20, 70, 10, 0, 0])],
            "2026-01-21": [run(30, [100, 0, 0, 0, 0])],  # later runs don't change earlier types
        }}
        d = daily_metrics(cache, date(2026, 1, 18), date(2026, 1, 20))
        self.assertEqual({day: [r["type"] for r in rs] for day, rs in d["runs"].items()},
                         {"2026-01-18": ["base"], "2026-01-20": ["long"]})
        self.assertEqual(recent_longest(cache["activities"], date(2026, 1, 19)), 20000)
        self.assertEqual(recent_longest(cache["activities"], date(2025, 12, 21)), 30000)
        self.assertEqual(recent_longest(cache["activities"], date(2026, 1, 20)), 12500)  # 20 km is 29 days back now

    def test_race_runs_are_flagged(self):
        race = dict(run(21.1, [0, 5, 30, 60, 5]), eventType={"typeKey": "race"})
        d = daily_metrics({"activities": {"2026-01-02": [run(2, [50, 50, 0, 0, 0]), race]}}, date(2026, 1, 2), date(2026, 1, 2))
        self.assertEqual([(r["type"], r["race"]) for r in d["runs"]["2026-01-02"]], [("base", False), ("long", True)])


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache_path = os.path.join(self.tmp.name, "cache.json")
        self.lt_path = os.path.join(self.tmp.name, "lactate_threshold.csv")
        self.server = make_server(self.cache_path, "127.0.0.1", 0, thresholds_path=self.lt_path)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path) as resp:
                return resp.status, json.load(resp)
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.load(e)

    def write_cache(self, cache):
        with open(self.cache_path, "w") as f:
            json.dump(cache, f)

    def test_health_is_503_until_a_cache_exists(self):
        self.assertEqual(self.get("/api/health")[0], 503)
        self.write_cache(CACHE)
        status, body = self.get("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

    def test_days(self):
        self.write_cache(CACHE)
        status, body = self.get("/api/days?start=2026-01-01&end=2026-01-04")
        self.assertEqual(status, 200)
        self.assertEqual(body["metrics"]["hrv"], {"2026-01-02": 45})

    def test_days_rereads_a_replaced_cache(self):
        self.write_cache(CACHE)
        self.get("/api/days?start=2026-01-01&end=2026-01-04")
        updated = json.loads(json.dumps(CACHE))
        updated["hrv"]["2026-01-03"] = {"lastNightAvg": 50}
        self.write_cache(updated)
        os.utime(self.cache_path, (1, 2))  # make sure the mtime changes even on coarse filesystems
        _, body = self.get("/api/days?start=2026-01-01&end=2026-01-04")
        self.assertEqual(body["metrics"]["hrv"], {"2026-01-02": 45, "2026-01-03": 50})

    def test_days_include_the_lactate_threshold_file_and_reread_it_when_it_changes(self):
        self.write_cache(CACHE)
        _, body = self.get("/api/days?start=2026-01-01&end=2026-01-02")
        self.assertEqual(body["metrics"]["lt_pace"], {})  # no file: no thresholds, not an error
        with open(self.lt_path, "w") as f:
            f.write("date,heart_rate,pace\n2025-12-20,168,4:45\n")
        _, body = self.get("/api/days?start=2026-01-01&end=2026-01-02")
        self.assertEqual(body["metrics"]["lt_pace"], {"2026-01-01": 285, "2026-01-02": 285})
        with open(self.lt_path, "w") as f:
            f.write("date,heart_rate,pace\n2025-12-20,168,4:45\n2026-01-02,165,4:40\n")
        os.utime(self.lt_path, (1, 2))
        _, body = self.get("/api/days?start=2026-01-01&end=2026-01-02")
        self.assertEqual(body["metrics"]["lt_hr"], {"2026-01-01": 168, "2026-01-02": 165})

    def test_bad_ranges(self):
        self.write_cache(CACHE)
        for query in ("", "?start=2026-01-01", "?start=x&end=2026-01-01", "?start=2026-02-01&end=2026-01-01",
                      "?start=2020-01-01&end=2026-01-01"):
            status, body = self.get("/api/days" + query)
            self.assertEqual(status, 400, query)
            self.assertIn("error", body)

    def test_keep_alive_and_a_deep_listen_queue(self):
        """A page load opens many connections at once: the backlog must hold them, and keep-alive reuses them."""
        import http.client
        self.assertGreaterEqual(self.server.request_queue_size, 64)
        self.write_cache(CACHE)
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        statuses = []
        for path in ("/api/health", "/api/days?start=2026-01-01&end=2026-01-04", "/api/nope", "/api/health"):
            conn.request("GET", path)  # all on one connection
            resp = conn.getresponse()
            resp.read()
            statuses.append(resp.status)
        conn.close()
        self.assertEqual(statuses, [200, 200, 404, 200])

    def test_many_simultaneous_connections_are_all_served(self):
        self.write_cache(CACHE)
        results = []

        def fetch():
            with urllib.request.urlopen(self.base + "/api/health", timeout=5) as resp:
                results.append(resp.status)

        threads = [threading.Thread(target=fetch) for _ in range(40)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results, [200] * 40)

    def test_unknown_path_is_404_without_static_dir(self):
        self.assertEqual(self.get("/index.html")[0], 404)


class StaticTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        web = os.path.join(self.tmp.name, "web")
        os.makedirs(os.path.join(web, "css"))
        with open(os.path.join(web, "index.html"), "w") as f:
            f.write("<!doctype html><title>t</title>")
        with open(os.path.join(web, "css", "base.css"), "w") as f:
            f.write("body{}")
        with open(os.path.join(self.tmp.name, "secret.txt"), "w") as f:
            f.write("outside web/")
        self.server = make_server(os.path.join(self.tmp.name, "cache.json"), "127.0.0.1", 0, web)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def status(self, path):
        try:
            with urllib.request.urlopen(self.base + path) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.headers, b""

    def test_serves_frontend_with_no_cache(self):
        code, headers, body = self.status("/")
        self.assertEqual(code, 200)
        self.assertIn(b"<title>t</title>", body)
        self.assertEqual(headers["Cache-Control"], "no-cache")
        self.assertEqual(self.status("/css/base.css")[0], 200)

    def test_no_directory_listing_or_escaping_the_web_dir(self):
        self.assertEqual(self.status("/css/")[0], 404)
        self.assertEqual(self.status("/../secret.txt")[0], 404)

    def test_static_files_and_errors_keep_the_connection_usable(self):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        seen = []
        for method, path in (("GET", "/css/base.css"), ("GET", "/missing.js"), ("HEAD", "/"), ("GET", "/css/")):
            conn.request(method, path)
            resp = conn.getresponse()
            resp.read()
            seen.append(resp.status)
        conn.close()
        self.assertEqual(seen, [200, 404, 200, 404])

    def test_api_still_answers_alongside_static_files(self):
        self.assertEqual(self.status("/api/health")[0], 503)
        self.assertEqual(self.status("/api/nope")[0], 404)


if __name__ == "__main__":
    unittest.main()
