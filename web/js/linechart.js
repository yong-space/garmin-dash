// Line and column charts as inline SVG strings, plus their legends.

import { CHART_H, CHART_PAD, MONTH_LABELS_MAX, RACE } from "./config.js";
import { iso, longDate, monthName, shortDate } from "./dates.js";
import { esc, fixed } from "./format.js";
import { bucketLabels } from "./stats.js";

const f1 = (x) => fixed(x, 1);

function starPoints(cx, cy, r) {
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const rad = k % 2 === 0 ? r : r * 0.45;
    const a = Math.PI / 2 + (k * Math.PI) / 5;
    pts.push(`${f1(cx + rad * Math.cos(a))},${f1(cy - rad * Math.sin(a))}`);
  }
  return pts.join(" ");
}

/**
 * Each point is one bucket of `spans` (see stats.periodSpans); `unit` is their granularity key (d/w/m/y).
 *
 * series: [{values (per bucket, null = no data), color, ticks, tickFmt, right (bool), bar (bool),
 *           axisColor (axis label colour, if not `color`), key (legend/hide key; default "s" + index)}].
 *   Give stacked column series a key: hidden choices are saved by key, so a positional default would
 *   reassign them when a series is added.
 * tips: per-bucket hover text; sums: optional one-line versions for the panel's readout (default: a tip's first line). stars: bucket indexes to mark with a race star (on the first series' point, or
 * above the column stack); starKey: the legend key that hides them (default "sr").
 * hidden: series keys the legend has switched off; hidden bar series aren't drawn, so the
 * stacks close up (hidden line series are hidden by CSS instead, see series.js).
 * Longer buckets leave a gap for one without data, unless `bridge` (sparse measurements, joined point to point);
 * daily lines always bridge missed days (a skipped weigh-in isn't a break in the trend) and use thinner strokes
 * and dots so ~90 points stay legible.
 * Bar series are drawn as stacked columns, all the same width, in series order from the bottom. Each
 * segment's height is measured on its own series' axis, so give the series proportional ticks (panels.js
 * does) for a stack to read as one total, and keep the totals within the axes.
 */
export function lineChart(spans, width, series, tips,
                          { unit = "w", sums = null, stars = [], starKey = "sr", hidden = new Set(), bridge = false } = {}) {
  const W = Math.max(Math.round(width), 240); // px: drawn 1:1, no scaling (a plot wider than its panel pans)
  const H = CHART_H;
  const [top, bottom, left] = CHART_PAD;
  const right = series.some((s) => s.right) ? 44 : 14;
  const n = spans.length;
  const daily = unit === "d";
  const [stroke, dot] = daily ? [1.5, 1.5] : [2, 2.6];
  const pw = W - left - right;
  const ph = H - top - bottom;
  const bw = pw / n;

  const x = (i) => left + (i + 0.5) * bw;
  const keyOf = (j) => series[j].key ?? `s${j}`;
  const colW = bw * 0.7; // column width, leaving a gap between buckets
  const scale = (s) => {
    const t0 = s.ticks[0];
    const t1 = s.ticks[s.ticks.length - 1];
    return (v) => top + ph * (1 - (v - t0) / (t1 - t0));
  };

  const out = [], leftAxis = [], rightAxis = []; // the axes are separate SVGs so they stay put while the plot pans
  series[0].ticks.forEach((t, k) => {
    const yy = scale(series[0])(t);
    out.push(`<line class="gl" x1="${left}" x2="${W - right}" y1="${f1(yy)}" y2="${f1(yy)}"/>`);
    // a line series' axis labels hide with it; a column axis stays (it measures the whole stack)
    const axisClass = (s, j) => (s.bar ? "" : ` class="${keyOf(j)}"`);
    leftAxis.push(
      `<text${axisClass(series[0], 0)} x="${left - 6}" y="${f1(yy + 4)}" text-anchor="end"` +
      ` style="fill:${series[0].axisColor ?? series[0].color}">${series[0].tickFmt(t)}</text>`
    );
    series.slice(1).forEach((s, j) => {
      if (s.right) {
        rightAxis.push(
          `<text${axisClass(s, j + 1)} x="${W - right + 6}" y="${f1(yy + 4)}" style="fill:${s.axisColor ?? s.color}">` +
          `${s.tickFmt(s.ticks[k])}</text>`
        );
      }
    });
  });
  bucketLabels(spans, { yearsOnly: unit === "m" && n > MONTH_LABELS_MAX }).forEach((label, i) => {
    if (label) out.push(`<text x="${f1(left + i * bw)}" y="${H - 5}">${label}</text>`);
  });

  [...series.keys()].reverse().forEach((j) => { // last series first, so the first (primary) line is drawn on top
    const s = series[j];
    const y = scale(s);
    const vals = s.values;
    if (s.bar) return; // drawn below, as stacks
    out.push(`<g class="${keyOf(j)}" data-k="${keyOf(j)}">`); // data-k: legend hover focus (series.js)
    const present = vals.flatMap((v, i) => (v !== null ? [i] : []));
    const segs = [];
    for (let p = 0; p + 1 < present.length; p++) {
      const [i, k] = [present[p], present[p + 1]];
      if (daily || bridge || k === i + 1) segs.push(`M${f1(x(i))},${f1(y(vals[i]))}L${f1(x(k))},${f1(y(vals[k]))}`);
    }
    if (segs.length) {
      out.push(
        `<path d="${segs.join("")}" fill="none" style="stroke:${s.color}" stroke-width="${stroke}"` +
        ` stroke-linecap="round" stroke-linejoin="round"/>`
      );
    }
    for (const i of present) out.push(`<circle cx="${f1(x(i))}" cy="${f1(y(vals[i]))}" r="${dot}" style="fill:${s.color}"/>`);
    out.push("</g>");
  });

  const baseline = top + ph;
  const stackTop = new Array(n).fill(baseline); // y of the top of each bucket's stack
  series.forEach((s, j) => {
    if (!s.bar || hidden.has(keyOf(j))) return;
    const y = scale(s);
    s.values.forEach((v, i) => {
      if (!(v > 0)) return;
      const h = Number(f1(y(0) - y(v))); // rounded first, so stacked segments share an exact edge
      out.push(
        `<rect class="${keyOf(j)} col" data-k="${keyOf(j)}" x="${f1(x(i) - colW / 2)}" y="${f1(stackTop[i] - h)}" width="${f1(colW)}"` +
        ` height="${f1(h)}" style="fill:${s.color}"/>`
      );
      stackTop[i] -= h;
    });
  });

  const y0 = scale(series[0]);
  out.push(`<g class="${starKey}" data-k="${starKey}">`);
  for (const i of hidden.has(starKey) ? [] : stars) {
    const v = series[0].values[i] || 0;
    const cy = series[0].bar ? stackTop[i] - 10 : y0(v); // above a column's stack, on a line's point
    out.push(`<polygon class="race-star" points="${starPoints(x(i), cy, 8)}" style="fill:${RACE}"/>`);
  }
  out.push("</g>");

  spans.forEach(([ws, we], i) => { // hover bands last so they sit on top
    const label = spanLabel(ws, we, unit);
    out.push(
      `<rect class="hit" x="${f1(left + i * bw)}" y="${top}" width="${f1(bw)}" height="${ph}"` +
      ` data-key="${iso(ws)}" data-date="${label}" data-tip="${esc(tips[i])}"${sums ? ` data-sum="${esc(sums[i])}"` : ""}/>`
    );
  });

  const svg = (x0, w, body, scroll = false) => { // one viewBox unit = one CSS px
    const tag = `<svg class="chart" viewBox="${x0} 0 ${w} ${H}" role="img" style="width:${w}px;height:${H}px">${body.join("")}</svg>`;
    return scroll ? `<div class="lcs">${tag}</div>` : tag;
  };

  return (
    `<div class="lcw"><div class="lc">` +
    `${svg(0, left, leftAxis)}${svg(left, pw, out, true)}${svg(W - right, right, rightAxis)}</div></div>`
  );
}

/** Hover title for a bucket: "Sun Nov 8", "Nov 3 – Nov 9", "Oct 2026" or "2025", even for a partial month or year. */
function spanLabel(ws, we, unit) {
  if (unit === "d") return longDate(ws);
  if (unit === "m") return `${monthName(ws)} ${ws.getUTCFullYear()}`;
  if (unit === "y") return String(ws.getUTCFullYear());
  return `${shortDate(ws)} – ${shortDate(we)}`;
}

/**
 * items: [label, color] for lines in series order ([label, color, "bar"] for columns), [label, "star"] for race stars.
 * A fourth element names the series explicitly, by index or by its key, so entries can be listed in any order
 * (["Race", "star", null, "race"]: a star swatch that toggles the "race" series).
 * With more than one item, each is a button that shows/hides its series (see series.js).
 */
export function lineLegend(...items) {
  let lineNo = 0;
  const parts = items.map(([label, color, kind, series]) => {
    let key, body;
    if (color === "star") {
      key = typeof series === "string" ? series : "sr";
      body = `<span class="sw star" style="background:${RACE}"></span> ${label}`;
    } else {
      key = typeof series === "string" ? series : `s${series ?? lineNo++}`;
      const swatch = kind === "bar" ? "sw" : "ln";
      body = `<span class="${swatch}" style="background:${color}"></span> ${label}`;
    }
    return items.length > 1 ? `<button type="button" class="li" data-s="${key}" aria-pressed="true">${body}</button>` : body;
  });
  return `<div class="legend">${parts.join("<span class=gap></span>")}</div>`;
}

/**
 * Columns are ~3px wide at fractional positions, so anti-aliasing makes some look thinner than others.
 * Snap every column's edges to whole device pixels (keeping one width per chart). Call after the charts
 * are laid out and visible, and again after a resize; hidden charts are skipped.
 */
export function snapColumns(root = document) {
  const dpr = window.devicePixelRatio || 1;
  for (const svg of root.querySelectorAll(".lcs svg")) {
    const cols = svg.querySelectorAll("rect.col");
    const box = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    if (!cols.length || !box.width) continue;
    const k = (box.width / vb.width) * dpr; // device px per viewBox unit
    const toUnits = (devX) => vb.x + (devX / dpr - box.left) / k * dpr;
    for (const rect of cols) {
      rect.dataset.x ??= rect.getAttribute("x"); // the unsnapped geometry, so snapping can be redone
      rect.dataset.w ??= rect.getAttribute("width");
      const width = Math.max(1, Math.round(Number(rect.dataset.w) * k));
      const left = Math.round((box.left + (Number(rect.dataset.x) - vb.x) * k / dpr) * dpr);
      rect.setAttribute("x", toUnits(left).toFixed(3));
      rect.setAttribute("width", (width / k).toFixed(3));
    }
  }
}
