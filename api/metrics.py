"""Turn the raw cache (see sync/cache.py) into per-day metric values in display units."""

import csv
import re
from collections import defaultdict
from datetime import date, timedelta


def daterange(start, end):
    for i in range((end - start).days + 1):
        yield start + timedelta(days=i)


def units(cache):
    imperial = (cache.get("profile") or {}).get("measurementSystem") == "statute_us"
    return {"distance": "mi" if imperial else "km", "weight": "lb" if imperial else "kg"}


DIST_DIV = {"km": 1000.0, "mi": 1609.344}  # Garmin reports metres
WEIGHT_DIV = {"kg": 1000.0, "lb": 453.59237}  # and grams

# Run types, from the activity summary (no per-second data needed):
LONG_RUN_METRES = 12000  # long: at least this far, whatever the intensity...
LONG_RUN_RECENT_SHARE = 0.65  # ...and at least this share of the longest non-race run in the lookback, so the bar
LONG_RUN_LOOKBACK_DAYS = 28  # rises late in a training block (a 12 km base run a few days after a 20 km long run isn't long)
REST_SPLITS = {"INTERVAL_REST", "INTERVAL_RECOVERY"}  # repeated efforts with rests: an interval set, unless easy
WORKOUT_SPLITS = REST_SPLITS | {"INTERVAL_WARMUP", "INTERVAL_COOLDOWN"}  # any structured workout
INTERVALS_MIN_HARD = 0.20  # a structured workout with this share of time in HR zones 4-5 is intervals
TEMPO_MIN_MODERATE = 0.50  # otherwise this share in zones 3-5 is tempo (threshold included); the rest is base


def is_race(activity):
    return (activity.get("eventType") or {}).get("typeKey") == "race"


def is_run(activity):
    return "running" in (activity.get("activityType") or {}).get("typeKey", "")


def recent_longest(activities, day):
    """The longest non-race run (metres) in the LONG_RUN_LOOKBACK_DAYS before `day` (a date), else 0.

    Only earlier days count, so a run's type never changes as later runs come in, and races are left out so one
    doesn't raise the bar for the month after it.
    """
    return max((a.get("distance") or 0
                for i in range(1, LONG_RUN_LOOKBACK_DAYS + 1)
                for a in activities.get((day - timedelta(days=i)).isoformat()) or []
                if is_run(a) and not is_race(a)), default=0)


def run_type(activity, recent_longest=0):
    """"long", "intervals", "tempo" or "base" for one running activity; recent_longest as returned by recent_longest()."""
    if (activity.get("distance") or 0) >= max(LONG_RUN_METRES, LONG_RUN_RECENT_SHARE * recent_longest):
        return "long"
    splits = {s.get("splitType") for s in activity.get("splitSummaries") or []}
    zones = [activity.get(f"hrTimeInZone_{z}") or 0 for z in range(1, 6)]
    total = sum(zones)

    def share(*zs):
        return sum(zones[z - 1] for z in zs) / total if total else 0

    # Rest splits make intervals unless heart rate was recorded and never reached zone 4 (an easy structured run).
    # Short reps can barely register in zones 4-5, so any time there counts; with no HR data, the splits decide.
    if splits & REST_SPLITS and (not total or share(4, 5) > 0):
        return "intervals"
    if splits & WORKOUT_SPLITS and share(4, 5) >= INTERVALS_MIN_HARD:
        return "intervals"
    if share(3, 4, 5) >= TEMPO_MIN_MODERATE:
        return "tempo"
    return "base"


PACE = re.compile(r"(\d+):([0-5]\d)")


def parse_thresholds(text):
    """The lactate threshold log, a CSV kept by hand: `date,heart_rate,pace` rows (pace as m:ss per km), each value
    holding from its date until the next row. Blank lines, lines starting with # and the header are skipped.

    Returns ([(date, bpm, pace in seconds per km)] sorted by date, [a message for each row that didn't parse]):
    a typo drops its row, not the whole log.
    """
    rows, problems = [], []
    for n, fields in enumerate(csv.reader(text.splitlines()), 1):
        if not fields or not "".join(fields).strip() or fields[0].lstrip().startswith("#") or fields[0].strip() == "date":
            continue
        try:
            day, bpm, pace = (f.strip() for f in fields)
            m = PACE.fullmatch(pace)
            if not m:
                raise ValueError(f"pace {pace!r} is not m:ss")
            rows.append((date.fromisoformat(day), int(bpm), int(m[1]) * 60 + int(m[2])))
        except ValueError as e:
            problems.append(f"line {n}: {','.join(fields)!r}: {e}")
    return sorted(rows), problems


def daily_metrics(cache, start, end, thresholds=()):
    """Per-day values for [start, end].

    metrics maps each name to {day: value}, with days without data left out, except weight and body_fat,
    which carry the latest reading forward (looking back before `start` for the first); weighed_on maps each
    day with a weight to the day that weight was measured, so a carried-forward value can be told apart.
    lt_pace (seconds per display distance unit), lt_hr and lt_since (the day that value was set) give each day the
    lactate threshold in effect, from `thresholds` as returned by parse_thresholds; days before its first row have none.
    races maps a day to its races, each {name, distance (display units), duration (seconds)}.
    runs maps a day to its runs in start order (the cache keeps activities in that order), each {type (see run_type), distance (display units), race (bool)};
    a run's type looks back LONG_RUN_LOOKBACK_DAYS before its day, before `start` too, so it doesn't depend on the range.
    """
    u = units(cache)
    dist_div, weight_div = DIST_DIV[u["distance"]], WEIGHT_DIV[u["weight"]]
    activities = cache.get("activities", {})
    sleeps, hrvs, summaries, weights = (cache.get(k, {}) for k in ("sleep", "hrv", "summaries", "weight"))

    run_dist = defaultdict(float)
    strength_mins, strength_count = defaultdict(float), defaultdict(int)
    races, runs = defaultdict(list), defaultdict(list)
    sleep_score, sleep_secs, hrv, rhr, weight, body_fat = {}, {}, {}, {}, {}, {}
    for d in daterange(start, end):
        day = d.isoformat()
        for a in activities.get(day) or []:
            if is_run(a):
                run_dist[day] += (a.get("distance") or 0) / dist_div
                runs[day].append({"type": run_type(a, recent_longest(activities, d)),
                                  "distance": (a.get("distance") or 0) / dist_div, "race": is_race(a)})
            elif (a.get("activityType") or {}).get("typeKey") == "strength_training":
                strength_count[day] += 1
                strength_mins[day] += (a.get("duration") or 0) / 60
            if is_race(a):
                races[day].append({
                    "name": a.get("activityName"),
                    "distance": (a.get("distance") or 0) / dist_div,
                    "duration": a.get("duration") or 0,
                })

        s = sleeps.get(day) or {}
        if s.get("sleepTimeSeconds"):
            sleep_secs[day] = s["sleepTimeSeconds"]
        score = ((s.get("sleepScores") or {}).get("overall") or {}).get("value")
        if score is not None:
            sleep_score[day] = score

        h = hrvs.get(day) or {}
        if h.get("lastNightAvg"):
            hrv[day] = h["lastNightAvg"]

        resting = ((summaries.get(day) or {}).get("heartRate") or {}).get("restingValue")
        if resting:
            rhr[day] = resting

        w = weights.get(day) or {}
        if w.get("weight"):
            weight[day] = w["weight"] / weight_div
        if w.get("bodyFat"):
            body_fat[day] = w["bodyFat"]

    weight, weighed_on = forward_fill(weight, weights, "weight", start, end, 1 / weight_div)
    body_fat, _ = forward_fill(body_fat, weights, "bodyFat", start, end)
    lt_pace, lt_hr, lt_since = {}, {}, {}
    current, upcoming = None, list(thresholds)  # sorted by date
    for d in daterange(start, end):
        while upcoming and upcoming[0][0] <= d:
            current = upcoming.pop(0)
        if current:
            day = d.isoformat()
            lt_since[day], lt_hr[day] = current[0].isoformat(), current[1]
            lt_pace[day] = current[2] * dist_div / 1000  # seconds per km -> per display unit
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "units": u,
        "metrics": {
            "run_dist": run_dist,
            "strength_mins": strength_mins, "strength_count": strength_count,
            "sleep_secs": sleep_secs, "sleep_score": sleep_score, "hrv": hrv, "rhr": rhr,
            "weight": weight, "weighed_on": weighed_on, "body_fat": body_fat,
            "lt_pace": lt_pace, "lt_hr": lt_hr, "lt_since": lt_since,
        },
        "races": races,
        "runs": runs,
    }


def forward_fill(values, cached, field, start, end, scale=1.0):
    """Fill days without a reading with the most recent earlier one, looking back before `start` for the first.

    `cached` is the per-day cache ({day: {field: reading} | None}); `scale` converts readings to display units.
    Returns ({day: value}, {day: the day that value was read}).
    """
    last, last_day = next(
        ((cached[day][field] * scale, day) for day in sorted(cached, reverse=True)
         if day < start.isoformat() and (cached[day] or {}).get(field)),
        (None, None),
    )
    out, source = {}, {}
    for d in daterange(start, end):
        day = d.isoformat()
        if day in values:
            last, last_day = values[day], day
        if last is not None:
            out[day], source[day] = last, last_day
    return out, source
