"""The cache file: Garmin API responses stored per day, cut down to KEEP. It is the contract between sync and api.

    {"profile": {"measurementSystem"},
     "activities": {date: [activity, ...]},       (in start order)
     "sleep": {date: summary | null},
     "hrv": {date: summary | null},
     "summaries": {date: daily summary | null},
     "weight": {date: {"weight": grams, "bodyFat": %} | null}}

Each response keeps Garmin's own field names and nesting, but only the fields in KEEP; null fields are left out.
A present date key means that day was fetched; [] / null means it had no data.
Only the sync command writes it, atomically (temp file + rename), so readers never see a partial file.
Writers hold locked(path) so two syncs (the scheduled one and a manual run, or the old and new pod during a rolling
deploy) never interleave. On a shared NFS volume the lock holds across nodes too (NFSv4 locks, local_lock=none).
"""

import contextlib
import fcntl
import json
import os
import tempfile

DAILY_SOURCES = ("activities", "sleep", "hrv", "summaries", "weight")

# The fields kept from each response: every field api/metrics.py reads, plus activityId, which the sync uses to
# replace a refetched activity. Paths are dotted; "[]" applies the rest of the path to each item of a list.
# Everything else is dropped before saving. To use another field, add it here, then delete the cache (or that
# source's days) so the next sync fetches them again with it.
KEEP = {
    "profile": ["measurementSystem"],
    "activities": ["activityId", "activityName", "activityType.typeKey", "eventType.typeKey", "distance", "duration",
                   "splitSummaries[].splitType", *(f"hrTimeInZone_{z}" for z in range(1, 6))],
    "sleep": ["sleepTimeSeconds", "sleepScores.overall.value"],
    "hrv": ["lastNightAvg"],
    "summaries": ["heartRate.restingValue"],
    "weight": ["weight", "bodyFat"],
}


def _tree(paths):
    """["a.b", "a.c", "d"] -> {"a": {"b": True, "c": True}, "d": True}"""
    tree = {}
    for path in paths:
        *parents, leaf = path.split(".")
        node = tree
        for key in parents:
            node = node.setdefault(key, {})
        node[leaf] = True
    return tree


def _project(value, tree):
    """The parts of the dict `value` named by `tree`, leaving out nulls and anything that ends up empty."""
    out = {}
    for key, sub in tree.items():
        many = key.endswith("[]")
        name = key[:-2] if many else key
        v = value.get(name)
        if v is None:
            continue
        if many:
            if not isinstance(v, list):
                continue
            v = [_project(item, sub) if sub is not True else item for item in v if isinstance(item, dict)]
        elif sub is not True:
            if not isinstance(v, dict):
                continue
            v = _project(v, sub)
            if not v:
                continue
        out[name] = v
    return out


_TREES = {source: _tree(paths) for source, paths in KEEP.items()}


def slim(source, item):
    """`item` (one response object from `source`) cut down to KEEP[source]. Idempotent; None stays None."""
    return None if item is None else _project(item, _TREES[source])


def load_cache(path):
    try:
        with open(path) as f:
            cache = json.load(f)
    except FileNotFoundError:
        cache = {}
    for key in DAILY_SOURCES:
        cache.setdefault(key, {})
    return cache


def save_cache(path, cache):
    """Write atomically: to a temp file of its own (so two writers can never share one), then rename over `path`."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix=os.path.basename(path) + ".",
                               suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(cache, f, separators=(",", ":"))
        os.chmod(tmp, 0o644)  # mkstemp creates it 0600
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


@contextlib.contextmanager
def locked(path):
    """Hold an exclusive lock on `path` (via a side file) for the duration; waits for any other holder."""
    with open(path + ".lock", "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
