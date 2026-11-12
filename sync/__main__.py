"""Sync once: fetch what's missing from Garmin into the cache file, then exit (non-zero on failure).

    python3 -m sync [--cache garmin_cache.json] [--refetch-activities START [END]]

Run it on a schedule (the k8s container runs it in a loop every REFRESH_SECONDS). --refetch-activities fetches
the activities from START to END (inclusive; END defaults to START) again, replacing what's cached, e.g. after
editing an activity in Garmin Connect.
"""

import argparse
import sys
import traceback
from datetime import date

from .backfill import history_start, refresh
from .client import Garmin, read_api_key


def parse_date(s):
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a YYYY-MM-DD date: {s!r}")


def main():
    ap = argparse.ArgumentParser(prog="python3 -m sync", description="Fetch Garmin data into the cache file.")
    ap.add_argument("--cache", default="garmin_cache.json")
    ap.add_argument("--refetch-activities", nargs="+", metavar=("START", "END"), type=parse_date,
                    help="fetch the activities from START to END (default START), YYYY-MM-DD, again")
    args = ap.parse_args()
    today = date.today()
    refetch = args.refetch_activities
    if refetch:
        if len(refetch) > 2:
            ap.error("--refetch-activities takes START and an optional END")
        refetch = (refetch[0], refetch[-1])
        if refetch[0] > refetch[1]:
            ap.error("--refetch-activities: END is before START")
        if refetch[1] > today or refetch[0] < history_start(today):
            ap.error(f"--refetch-activities: dates must be from {history_start(today)} to {today}")

    log = lambda m: print(m, flush=True)
    try:
        refresh(args.cache, Garmin(read_api_key(), log=log), today, log=log, refetch_activities=refetch)
    except Exception:
        log("sync failed:\n" + traceback.format_exc())
        sys.exit(1)
    log("sync ok")


if __name__ == "__main__":
    main()
