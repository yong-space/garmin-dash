// Client for the read API (api/server.py).

const API_BASE = "api"; // relative, so the page works under any path prefix

/**
 * Per-day metrics for [start, end] (ISO dates):
 * {start, end, units: {distance, weight}, metrics: {name: {day: value}}, races: {day: [{name, distance, duration}]},
 *  runs: {day: [{type, distance}]}}
 */
export async function fetchDays(start, end) {
  const res = await fetch(`${API_BASE}/days?start=${start}&end=${end}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API returned ${res.status}`);
  }
  return res.json();
}

const responses = []; // {start, end, promise} for every fetch so far (failed ones are dropped, so they can be retried)

/**
 * fetchDays(start, end), reusing an earlier response that covers the range (sliced to it) instead of fetching.
 * Concurrent calls for a covered range share the one request.
 */
export function getDays(start, end) {
  const hit = responses.find((r) => r.start <= start && end <= r.end);
  if (hit) return hit.promise.then((d) => sliceDays(d, start, end));
  const entry = { start, end, promise: fetchDays(start, end) };
  responses.push(entry);
  entry.promise.catch(() => responses.splice(responses.indexOf(entry), 1));
  return entry.promise;
}

/** The same response restricted to [start, end] (ISO dates), so one fetch serves every shorter horizon. */
export function sliceDays(data, start, end) {
  const inRange = ([day]) => start <= day && day <= end;
  const slice = (obj) => Object.fromEntries(Object.entries(obj).filter(inRange));
  return {
    ...data,
    start,
    end,
    metrics: Object.fromEntries(Object.entries(data.metrics).map(([name, days]) => [name, slice(days)])),
    races: slice(data.races),
    runs: slice(data.runs),
  };
}
