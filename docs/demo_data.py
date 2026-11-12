"""Write a made-up cache and lactate threshold CSV, for screenshots and trying the dashboard without a Garmin account.

    python3 docs/demo_data.py DIR          # writes DIR/garmin_cache.json and DIR/lactate_threshold.csv
    python3 -m api --cache DIR/garmin_cache.json --lactate-threshold DIR/lactate_threshold.csv --static web

Two years ending today: a runner building through a spring half marathon and an autumn marathon, lifting twice a
week. Seeded, so the same day gives the same data. None of it is real.
"""

import json
import math
import os
import random
import sys
from datetime import date, timedelta

DAYS = 730
rng = random.Random(7)


def zones(secs, mix):
    """Split `secs` across HR zones 1-5 by the weights in `mix`, with some noise."""
    w = [max(0.0, m * rng.uniform(0.8, 1.2)) for m in mix]
    return {f"hrTimeInZone_{z}": round(secs * x / sum(w), 1) for z, x in enumerate(w, 1)}


def run(i, name, km, pace, mix, splits=(), race=False):
    secs = km * pace
    return {"activityId": i, "activityName": name, "activityType": {"typeKey": "running"},
            "eventType": {"typeKey": "race" if race else "uncategorized"},
            "distance": round(km * 1000, 1), "duration": round(secs, 1),
            "splitSummaries": [{"splitType": t} for t in ("INTERVAL_ACTIVE", *splits)], **zones(secs, mix)}


def build(today):
    start = today - timedelta(days=DAYS - 1)
    races = {start + timedelta(days=n): r for n, r in (
        (150, ("Harbour 10K", 10.0, 262)), (300, ("Riverside Half Marathon", 21.1, 279)),
        (420, ("Hill Country 10K", 10.0, 255)), (530, ("Bayside Half Marathon", 21.1, 270)),
        (640, ("City Marathon", 42.2, 292)))}
    cache = {"profile": {"measurementSystem": "metric"},
             **{k: {} for k in ("activities", "sleep", "hrv", "summaries", "weight")}}
    fitness, weight, ids, plan = 0.0, 74.5, iter(range(1, 10 ** 6)), {}
    for n in range(DAYS):
        d = start + timedelta(days=n)
        day, wd = d.isoformat(), d.weekday()
        fitness = min(1.0, fitness + 0.0018) if n % 365 < 330 else max(0.0, fitness - 0.01)  # build, then a break
        taper = any(0 <= (r - d).days < 10 for r in races)
        scale = (0.75 + 0.45 * fitness) * (0.6 if taper else 1.0) * (0.75 if (n // 7) % 4 == 3 else 1.0)
        acts = []
        if wd == 0 or not plan:  # this week's plan: which days the key sessions land on
            plan = {rng.choice((1, 2)): "intervals", rng.choice((3, 4)): "tempo", rng.choice((5, 5, 6)): "long"}
        if d in races:
            name, km, pace = races[d]
            acts.append(run(next(ids), name, km, pace * rng.uniform(0.99, 1.01), [0, 3, 20, 70, 7], race=True))
        elif rng.random() < 0.9:  # an occasional missed session
            easy = 345 - 20 * fitness
            session = plan.get(wd)
            if session == "intervals":
                acts.append(run(next(ids), "Track - Intervals", rng.uniform(7, 10) * scale, easy - 40,
                                [30, 25, 15, 20, 10], ["INTERVAL_WARMUP", "INTERVAL_REST", "INTERVAL_COOLDOWN"]))
            elif session == "tempo":
                acts.append(run(next(ids), "Tempo", rng.uniform(8, 11) * scale, easy - 35, [5, 20, 60, 15, 0]))
            elif session == "long":
                acts.append(run(next(ids), "Long Run", rng.uniform(14, 18) * scale + 6 * fitness, easy + 10,
                                [15, 75, 10, 0, 0]))
            elif rng.random() < 0.45 + 0.3 * fitness:
                acts.append(run(next(ids), "Easy Run", rng.uniform(6, 10) * scale, easy + 15, [25, 70, 5, 0, 0]))
        if wd in (0, 3) and rng.random() < 0.8 or wd == 5 and rng.random() < 0.15:
            acts.append({"activityId": next(ids), "activityName": "Strength", "activityType": {"typeKey": "strength_training"},
                         "eventType": {"typeKey": "uncategorized"}, "duration": round(rng.uniform(40, 75) * 60, 1)})
        cache["activities"][day] = acts

        hours = rng.gauss(7.3 + (0.5 if wd >= 5 else 0), 0.6)
        cache["sleep"][day] = {"sleepTimeSeconds": int(hours * 3600),
                               "sleepScores": {"overall": {"value": max(40, min(98, round(36 + 6.5 * hours + rng.gauss(0, 8))))}}}
        cache["hrv"][day] = {"lastNightAvg": round(52 + 10 * fitness + 3 * math.sin(n / 9) + rng.gauss(0, 4))}
        cache["summaries"][day] = {"heartRate": {"restingValue": round(56 - 6 * fitness + rng.gauss(0, 1.5))}}
        weight += rng.gauss(-0.004 if fitness < 0.9 else 0.006, 0.08)
        cache["weight"][day] = ({"weight": round(weight * 1000 + rng.gauss(0, 300)),
                                 "bodyFat": round(12 + (weight - 68) * 0.8 + rng.gauss(0, 0.4), 1)}
                                if rng.random() < 0.55 else None)

    lt = ["date,heart_rate,pace"]
    for k, n in enumerate(range(20, DAYS, 56)):
        pace = round(300 - 22 * min(1.0, k / 9) + rng.uniform(-3, 3))
        lt.append(f"{start + timedelta(days=n)},{rng.choice((168, 169, 170, 171, 172))},{pace // 60}:{pace % 60:02d}")
    return cache, "\n".join(lt) + "\n"


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    cache, lt = build(date.today())
    with open(os.path.join(out, "garmin_cache.json"), "w") as f:
        json.dump(cache, f)
    with open(os.path.join(out, "lactate_threshold.csv"), "w") as f:
        f.write(lt)
    print(f"wrote {out}/garmin_cache.json and {out}/lactate_threshold.csv")
