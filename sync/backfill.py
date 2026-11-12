"""Incremental sync: fetch only days missing from the cache, plus the most recent days.

Work is split into chunks (one request's range per source) and done newest first across all sources, so recent
days are always refreshed before any backfill, and the cache is saved after every chunk: a sync that fails
partway (after the client's retries, see client.py) keeps what it fetched, and the next one resumes from there.
"""

import calendar
import re
from datetime import date, timedelta

from .cache import DAILY_SOURCES, load_cache, locked, save_cache, slim

SLEEP_MAX_DAYS = 30  # dailySleepSummariesByDate rejects longer ranges
HRV_MAX_DAYS = 366  # hrv/daily rejects longer ranges
SUMMARY_MAX_DAYS = 365  # v2/dailysummaries: a year per request is known to work
WEIGHT_MAX_DAYS = 365  # weight/range: up to 3 years returned 200, 5 years returned 500
ACTIVITIES_MAX_DAYS = 90  # no endpoint limit (it pages), but bounded so a backfill saves progress as it goes
REFRESH_DAYS = 2  # always refetch today and yesterday: sleep/HRV/activities may not have synced yet
HISTORY_MONTHS = 60  # backfill window, ending today: five years (from its week's Monday)


def daterange(start, end):
    for i in range((end - start).days + 1):
        yield start + timedelta(days=i)


def chunks(start, end, max_days):
    """[start, end] as ranges of at most max_days, newest first (the first one ends on `end`)."""
    while start <= end:
        chunk_start = max(end - timedelta(days=max_days - 1), start)
        yield chunk_start, end
        end = chunk_start - timedelta(days=1)


def missing_ranges(cached, start, end, refresh_from):
    """Contiguous (start, end) runs of days not yet in `cached`, plus all days >= refresh_from."""
    ranges = []
    for d in daterange(start, end):
        if d.isoformat() in cached and d < refresh_from:
            continue
        if ranges and ranges[-1][1] == d - timedelta(days=1):
            ranges[-1][1] = d
        else:
            ranges.append([d, d])
    return ranges


def history_start(today, months=HISTORY_MONTHS):
    """The Monday of the week containing the day after the same date `months` months ago.

    That covers the longest range the dashboard asks for (api.server.MAX_DAYS allows it); the weekly run chart
    draws whole calendar weeks, so its first week reaches back to the Monday.
    """
    year, month0 = divmod(today.year * 12 + today.month - 1 - months, 12)
    horizon_start = date(year, month0 + 1, min(today.day, calendar.monthrange(year, month0 + 1)[1])) + timedelta(days=1)
    return horizon_start - timedelta(days=horizon_start.weekday())


def store_activities(cache, start, end, activities):
    """Record [start, end] as fetched: each day gets its activities in start order (replacing any with the same
    id), slimmed (see cache.KEEP), else []. Garmin lists them newest first, and startTimeLocal isn't kept."""
    acts = cache["activities"]
    for d in daterange(start, end):
        acts[d.isoformat()] = []
    for a in sorted(activities, key=lambda a: a["startTimeLocal"]):
        day = acts.setdefault(a["startTimeLocal"][:10], [])
        day[:] = [x for x in day if x.get("activityId") != a.get("activityId")] + [slim("activities", a)]


def store_daily(name):
    """A store for a per-day source: each day in [start, end] gets its item, slimmed, else None.
    Items without a date (Garmin sometimes sends an all-null placeholder) are skipped."""
    def store(cache, start, end, items):
        days = cache[name]
        for d in daterange(start, end):
            days[d.isoformat()] = None
        for item in items:
            if item.get("calendarDate"):
                days[item["calendarDate"]] = slim(name, item)
    return store


DAY_KEY = re.compile(r"\d{4}-\d{2}-\d{2}")


def tidy(cache, start):
    """Drop days before `start` (outside the history window) and keys that aren't dates, and slim every entry.

    Slimming is a no-op on entries already slim, so this also converts a cache written before slimming: its
    activities are put in start order first, while they still have startTimeLocal.
    """
    for source in DAILY_SOURCES:
        days = cache[source]
        for key in [k for k in days if k < start.isoformat() or not DAY_KEY.fullmatch(k)]:
            del days[key]
        for key, value in days.items():
            if source == "activities":
                value.sort(key=lambda a: a.get("startTimeLocal") or "")
                days[key] = [slim(source, a) for a in value]
            else:
                days[key] = slim(source, value)


def sources(api):
    """(name, fetch, max days per request, store) for each per-day source, in fetch order for a given chunk end."""
    return [
        ("activities", api.activities, ACTIVITIES_MAX_DAYS, store_activities),
        ("sleep", api.sleep, SLEEP_MAX_DAYS, store_daily("sleep")),
        ("hrv", api.hrv, HRV_MAX_DAYS, store_daily("hrv")),
        ("summaries", api.daily_summaries, SUMMARY_MAX_DAYS, store_daily("summaries")),
        ("weight", api.weight, WEIGHT_MAX_DAYS, store_daily("weight")),
    ]


def plan(cache, api, start, end, refresh_from):
    """Every chunk to fetch, as (name, fetch, store, chunk start, chunk end), newest chunk end first."""
    work = []
    for order, (name, fetch, max_days, store) in enumerate(sources(api)):
        for s, e in missing_ranges(cache[name], start, end, refresh_from):
            for cs, ce in chunks(s, e, max_days):
                work.append((ce, order, (name, fetch, store, cs, ce)))
    work.sort(key=lambda w: (-w[0].toordinal(), w[1]))
    return [w[2] for w in work]


def sync(api, cache, start, end, log=print, save=lambda: None, refetch_activities=None):
    """Fill `cache` (see cache.py) for [start, end] from `api` (a client.Garmin or anything shaped like it).

    Days before `start` are dropped first (see tidy). Each chunk is fetched before its days are marked, then save() is called (once at the end if nothing was
    due), so a failure leaves the cache holding exactly the chunks that completed. The failure itself is raised.

    refetch_activities, a (first, last) pair of dates, drops those days' activities first so they're fetched again,
    e.g. after editing an activity in Garmin Connect. If the sync fails before reaching them, they stay missing, so
    the next sync fetches them anyway.
    """
    refresh_from = end - timedelta(days=REFRESH_DAYS - 1)
    cache["profile"] = slim("profile", api.profile_settings())
    tidy(cache, start)
    if refetch_activities:
        for d in daterange(*refetch_activities):
            cache["activities"].pop(d.isoformat(), None)
    work = plan(cache, api, start, end, refresh_from)
    for n, (name, fetch, store, cs, ce) in enumerate(work, 1):
        log(f"[{n}/{len(work)}] {name} {cs} → {ce}")
        store(cache, cs, ce, fetch(cs, ce))
        save()
    if not work:
        save()  # still keep the refreshed profile


def refresh(cache_path, api, today, log=print, refetch_activities=None):
    """One full sync of the history window into the cache file, saved after every chunk (see sync).

    Raises on failure; the file then holds everything fetched before it, and the next run picks up the rest.
    """
    with locked(cache_path):
        cache = load_cache(cache_path)
        sync(api, cache, history_start(today), today, log=log, save=lambda: save_cache(cache_path, cache),
             refetch_activities=refetch_activities)
