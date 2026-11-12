// Numeric helpers for the charts: colour bins, axis ticks and time buckets.

import { GRANULARITIES, MAX_POINTS, MIN_POINTS } from "./config.js";
import { addDays, daterange, iso, mondayOf, monthName } from "./dates.js";
import { roundEven, roundTo } from "./format.js";

/** Sum with Neumaier compensation (as Python's sum() does), so float averages don't drift in the last digit. */
export function fsum(values) {
  let total = 0, c = 0;
  for (const x of values) {
    const t = total + x;
    c += Math.abs(total) >= Math.abs(x) ? total - t + x : x - t + total;
    total = t;
  }
  return c ? total + c : total;
}

/** Four rounded cut points splitting values into n roughly equal bins (step overrides the rounding unit). */
export function quantileEdges(values, n = 5, step = null) {
  const vals = [...values].sort((a, b) => a - b);
  if (!vals.length) return [1, 2, 3, 4];
  let edges = [];
  for (let i = 1; i < n; i++) edges.push(vals[Math.min(vals.length - 1, Math.floor((vals.length * i) / n))]);
  if (step === null) step = vals[vals.length - 1] - vals[0] < 50 ? 1 : vals[vals.length - 1] < 2000 ? 10 : 100;
  edges = edges.map((e) => roundTo(roundEven(e / step) * step, 6));
  for (let i = 1; i < edges.length; i++) edges[i] = roundTo(Math.max(edges[i], edges[i - 1] + step), 6); // strictly increasing
  return edges;
}

/** Which of the five colour bins (0..4) a value falls in. */
export const level = (value, edges) => edges.filter((e) => value >= e).length;

/** The smallest 1/2/2.5/5 x 10^k step >= raw, with at most `decimals` decimals (0.25 -> 0.5 for one decimal). */
export function niceStep(raw, decimals = Infinity) {
  for (let mag = 10 ** Math.floor(Math.log10(raw)); ; mag *= 10) {
    const fits = (s) => decimals === Infinity || Math.abs(roundTo(s, decimals) - s) < 1e-9;
    const step = [1, 2, 2.5, 5, 10].map((m) => roundTo(m * mag, 12)).find((s) => s >= raw && fits(s));
    if (step !== undefined) return step;
  }
}

/**
 * Evenly spaced y-axis ticks covering `values`; `count` forces that many ticks (to align a second axis);
 * `decimals` caps the step's precision (run distance and strength hours: one decimal, like their values).
 */
export function axisTicks(values, zero, count = null, decimals = Infinity) {
  let vals = values.filter((v) => v !== null);
  if (!vals.length) vals = [0];
  const lo0 = Math.min(...vals);
  const hi0 = Math.max(...vals);
  if (count && !zero) {
    let step = niceStep(Math.max(hi0 - lo0, 1e-9) / (count - 1), decimals);
    while (Math.floor(lo0 / step) * step + step * (count - 1) < hi0 - 1e-9) step = niceStep(step * 1.0001, decimals); // next nice step up
    const first = Math.floor(lo0 / step) * step;
    return Array.from({ length: count }, (_, i) => first + i * step);
  }
  if (count) {
    const step = niceStep(Math.max(hi0, 1e-9) / (count - 1), decimals);
    return Array.from({ length: count }, (_, i) => roundTo(i * step, 12));
  }
  const lo = zero ? 0 : lo0;
  let hi = hi0;
  if (hi - lo < 1e-9) hi = lo + 1;
  const step = niceStep((hi - lo) / 4, decimals);
  const ticks = [Math.floor(lo / step) * step];
  while (ticks[ticks.length - 1] < hi - 1e-9) ticks.push(roundTo(ticks[ticks.length - 1] + step, 12));
  return ticks;
}

const firstOfMonth = (d, add = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1));
const firstOfYear = (d, add = 0) => new Date(Date.UTC(d.getUTCFullYear() + add, 0, 1));
/** Per granularity key: the start of the calendar period containing a day, and the start of the next period. */
const PERIODS = {
  d: { of: (d) => d, next: (d) => addDays(d, 1) },
  w: { of: mondayOf, next: (d) => addDays(d, 7) }, // Monday-start, like the heatmap's columns
  m: { of: (d) => firstOfMonth(d), next: (d) => firstOfMonth(d, 1) },
  y: { of: (d) => firstOfYear(d), next: (d) => firstOfYear(d, 1) },
};

/**
 * [first day, last day] of each calendar day/week/month/year (`unit`: a GRANULARITIES key) in [start, end].
 * The last one ends at `end`, so it is usually partial. A partial first one (starting before `start`) is
 * dropped, unless keepPartialFirst, which starts it at `start` instead.
 */
export function periodSpans(start, end, unit, keepPartialFirst = false) {
  const { of, next } = PERIODS[unit];
  const spans = [];
  for (let ps = of(start); ps <= end; ps = next(ps)) {
    if (ps < start && !keepPartialFirst) continue;
    const pe = addDays(next(ps), -1);
    spans.push([ps < start ? start : ps, pe < end ? pe : end]);
  }
  return spans;
}

/**
 * The granularity keys a range offers: those giving MIN_POINTS..MAX_POINTS buckets. If none does (the first days
 * of a year-to-date range), daily.
 */
export function granularitiesFor(start, end, keepPartialFirst = false) {
  const fit = GRANULARITIES.map((g) => g.key).filter((key) => {
    const n = periodSpans(start, end, key, keepPartialFirst).length;
    return n >= MIN_POINTS && n <= MAX_POINTS;
  });
  return fit.length ? fit : ["d"];
}

/**
 * One x-axis label per bucket: the month name of the bucket containing the 1st, with January shown as its year
 * ("Oct Nov Dec 2026 Feb"), else "". yearsOnly labels only the Januaries, for charts with too many months to name.
 * A first bucket without a 1st is labelled with its own month, unless the next label would collide with it.
 */
export function bucketLabels(spans, { yearsOnly = false } = {}) {
  const name = (d) => (d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : monthName(d));
  let lastMonth = null; // year * 12 + month of the last label
  let leading = false; // whether labels[0] is a first-bucket fallback (not a 1st)
  const labels = spans.map(([ws, we], i) => {
    let monthDay = [...daterange(ws, we)].find((d) => d.getUTCDate() === 1);
    if (!monthDay && i === 0 && !yearsOnly) [monthDay, leading] = [ws, true];
    const month = monthDay && monthDay.getUTCFullYear() * 12 + monthDay.getUTCMonth();
    if (!monthDay || month === lastMonth || (yearsOnly && monthDay.getUTCMonth() !== 0)) return "";
    lastMonth = month;
    return name(monthDay);
  });
  if (leading && labels.slice(1, 3).some(Boolean)) labels[0] = ""; // it would collide with the next one
  return labels;
}

/** Aggregate {day: value} into buckets: "sum" (days without data count as 0) or "mean" (null if no data). */
export function bucketed(spans, daily, how) {
  return spans.map(([ws, we]) => {
    const vals = [...daterange(ws, we)].map(iso).filter((d) => d in daily).map((d) => daily[d]);
    const total = fsum(vals);
    if (how === "sum") return total;
    return vals.length ? total / vals.length : null;
  });
}
