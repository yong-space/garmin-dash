// Dashboard settings: time horizons, chart colours and chart geometry.

import { monthsAgo, addDays } from "./dates.js";

/**
 * Toggle options; every range ends today. `granularity` is the line charts' default bucket (see GRANULARITIES).
 * Line-chart buckets are calendar days, weeks, months or years; a partial first one is dropped, unless
 * `startsOnStart` keeps it, starting at the range start (YTD: from 1 Jan, never before). `lineOnly` horizons have
 * no heatmap (5Y would be ~260 week columns); in heatmap mode they're hidden.
 */
export const HORIZONS = [
  { key: "3m", label: "3M", start: (today) => addDays(monthsAgo(today, 3), 1), granularity: "d" },
  { key: "6m", label: "6M", start: (today) => addDays(monthsAgo(today, 6), 1), granularity: "w" },
  { key: "ytd", label: "YTD", start: (today) => new Date(Date.UTC(today.getUTCFullYear(), 0, 1)), granularity: "w",
    startsOnStart: true },
  { key: "1y", label: "1Y", start: (today) => addDays(monthsAgo(today, 12), 1), granularity: "w" },
  { key: "5y", label: "5Y", start: (today) => addDays(monthsAgo(today, 60), 1), granularity: "m", lineOnly: true },
];
export const DEFAULT_HORIZON = "6m";
export const LINE_ONLY_FALLBACK = "1y"; // switching to heatmap mode on a lineOnly horizon moves to this one
export const CHART_MODES = ["heat", "line"]; // first is the default

/**
 * Line-chart bucket sizes, finest first. A horizon offers the ones giving MIN_POINTS..MAX_POINTS buckets (after
 * dropping a partial first one); MAX_POINTS is about the 3M daily chart, the densest that stays legible.
 * `name` labels legends and tooltips; `per` is the run headline's period.
 */
export const GRANULARITIES = [
  { key: "d", label: "D", title: "Daily", name: "Daily", per: "weekly" }, // a daily run average is no use: weekly
  { key: "w", label: "W", title: "Weekly", name: "Weekly", per: "weekly" },
  { key: "m", label: "M", title: "Monthly", name: "Monthly", per: "monthly" },
  { key: "y", label: "Y", title: "Yearly", name: "Yearly", per: "yearly" },
];
export const MIN_POINTS = 5;
export const MAX_POINTS = 100;
export const MONTH_LABELS_MAX = 24; // more monthly buckets than this: label only the Januaries (as years)

// Colours are CSS custom properties, defined for both themes in css/theme.css (with the reasoning behind each), so
// charts follow a theme switch without redrawing. They go in style attributes, never SVG presentation attributes,
// which don't reliably take var().
const ramp = (name) => [0, 1, 2, 3, 4].map((step) => `var(--${name}-${step})`);
export const PALETTES = {
  green: ramp("green"), purple: ramp("purple"), blue: ramp("blue"), red: ramp("red"), teal: ramp("teal"), orange: ramp("orange"),
};
export const LINE_STEP = 2; // line charts draw each metric in this step of its palette (0 low … 4 high)
export const RUN_LINE = "var(--run-line)"; // weekly run line
export const EMPTY = "var(--empty)"; // a day without data
export const STRENGTH = "var(--strength)";
export const AXIS_INK = "var(--label)"; // axis text where no single series colour fits (stacked columns, muted strength)
/** Run types (classified by the API) in stacking order, for the daily run columns and the run heatmap. */
export const RUN_TYPES = [
  { key: "base", label: "Base", color: "var(--run-base)" },
  { key: "tempo", label: "Tempo", color: "var(--run-tempo)" },
  { key: "intervals", label: "Intervals", color: "var(--run-intervals)" },
  { key: "long", label: "Long", color: "var(--run-long)" },
];
export const RACE = "var(--race)"; // races everywhere (columns, stars, heatmap cells, legends)

// Heatmaps
export const DAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];
export const TWO_COLUMN_MAX_WEEKS = 28; // heatmaps: longer horizons stack panels full-width (keep in sync with --phone-weeks in css/heatmap.css)
export const MAX_COLUMN_PX = 26; // cap cell size on short horizons

// Line charts
export const LINE_TWO_COLUMN_MAX_POINTS = 28; // line charts with more points stack panels full-width (3M daily: 92)
export const RUN_COLUMN_STEP = 5; // daily run columns (D): distance gridline every 5 km / mi
export const STRENGTH_HOUR_AS_DISTANCE = { km: 10, mi: 5 }; // stacked on a run, an hour of strength is as tall as this much distance (mi: 5 keeps the hour ticks whole)
// Charts are drawn at the width their panel is displayed at (measured by main.js), always CHART_H tall, so every
// horizon gets the same height and text size at any window width.
export const CHART_H = 190;
export const PHONE_PAN = 2; // on phones, long horizons are drawn this many panel-widths wide and pan sideways
export const CHART_PAD = [10, 22, 44]; // top, bottom, left; right padding depends on whether there is a right axis
