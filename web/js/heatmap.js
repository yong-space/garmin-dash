// GitHub-style heatmap grid and its colour legend, as HTML strings.

import { DAY_LABELS, EMPTY, MAX_COLUMN_PX, RACE } from "./config.js";
import { addDays, daysBetween, iso, longDate, monthName, weekday } from "./dates.js";
import { esc } from "./format.js";
import { level } from "./stats.js";

const firstMonday = (start) => addDays(start, -weekday(start));

export const weekCount = (start, end) => Math.floor(daysBetween(firstMonday(start), end) / 7) + 1;

/** One label per week column: the month name where a month starts, else "". */
function monthLabels(start, end) {
  const monday = firstMonday(start);
  let lastMonth = null;
  const labels = [];
  for (let w = 0; w < weekCount(start, end); w++) {
    const weekStart = addDays(monday, 7 * w);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    let monthDay = days.find((d) => d.getUTCDate() === 1 && start <= d && d <= end) || null;
    if (w === 0 && !monthDay) monthDay = start > weekStart ? start : weekStart;
    const label = monthDay && monthDay.getUTCMonth() !== lastMonth ? monthName(monthDay) : "";
    if (label) lastMonth = monthDay.getUTCMonth();
    labels.push(label);
  }
  if (labels.slice(1, 3).some(Boolean)) labels[0] = ""; // leading partial month would collide with the next label
  return labels;
}

/**
 * The grid: columns are Monday-start weeks, rows are weekdays.
 * cellFor(day) -> {color, tip, sum, star (bool), keys} for each day in range (sum: optional one-line tip for the
 * panel's readout, see tooltip.js); colour is any CSS background, and keys
 * (space-separated) the legend series the cell belongs to, for legend hover focus (series.js).
 */
export function heatGrid(start, end, cellFor) {
  const monday = firstMonday(start);
  const weeks = weekCount(start, end);
  const months = monthLabels(start, end).map((label) => `<div class="mlabel">${label}</div>`);

  const cells = [];
  for (let row = 0; row < 7; row++) {
    cells.push(`<div class="dlabel">${DAY_LABELS[row]}</div>`);
    for (let w = 0; w < weeks; w++) {
      const d = addDays(monday, 7 * w + row);
      if (!(start <= d && d <= end)) {
        cells.push('<div class="cell blank"></div>');
        continue;
      }
      const { color, tip, sum, star, keys } = cellFor(iso(d));
      // a race star is cut out of an inner element, not the cell, so the cell can still draw a selection ring
      const [paint, inner] = star ? ["", `<span style="background:${color}"></span>`] : [` style="background:${color}"`, ""];
      cells.push(
        `<div class="${star ? "cell star" : "cell"}"${keys ? ` data-k="${keys}"` : ""}${paint}` +
        ` data-key="${iso(d)}" data-date="${longDate(d)}" data-tip="${esc(tip)}"${sum ? ` data-sum="${esc(sum)}"` : ""}>${inner}</div>`
      );
    }
  }

  // Phones pan long grids sideways (css/heatmap.css). The grid's own day labels would scroll and overscroll-stretch
  // with the cells there, so a copy of them (.dcol) sits over the scroller's left edge, outside it, instead.
  const dayColumn = `<div class="dcol" aria-hidden="true"><div class="mlabel">&nbsp;</div>` +
    `${DAY_LABELS.map((label) => `<div class="dlabel">${label}</div>`).join("")}</div>`;
  return (
    `<div class="hwrap">${dayColumn}<div class="hscroll"><div class="grid" style="--weeks:${weeks};` +
    ` grid-template-columns: 36px repeat(${weeks}, minmax(0,1fr));` +
    ` max-width:${36 + weeks * MAX_COLUMN_PX}px">` +
    `<div></div>${months.join("")}${cells.join("")}</div></div></div>`
  );
}

/**
 * Phones: mark a panning heatmap whose earlier weeks are off to the left (.more-left on its wrapper), so the day
 * column fades the cells into it as a hint that it pans. Kept up to date on every scroll; call it after setting
 * scrollLeft yourself, since that fires no scroll event when the position doesn't change.
 */
export function updatePanHint(scroller) {
  scroller.parentElement.classList.toggle("more-left", scroller.scrollLeft > 1);
}
document.addEventListener("scroll", (e) => { // scroll doesn't bubble, so listen in the capture phase
  if (e.target.classList?.contains("hscroll")) updatePanHint(e.target);
}, { capture: true, passive: true });

/**
 * A heatmap of one value per day, coloured by magnitude.
 *
 * values: {day: value}; edges: four cut points for palette[0..4]; fmt: (value, day) -> tooltip text.
 * Days in `marks` are drawn in markColor, split diagonally on days that also have a value.
 * Days in `stars` ({day: tooltip text}) are drawn as a starColor star with that tooltip.
 * emptyTip: tooltip for a day with nothing to show.
 */
export function heatmap(start, end, values, edges, palette, fmt,
                        { marks = new Set(), markColor = null, markLabel = "", stars = {}, starColor = RACE, emptyTip = "—" } = {}) {
  return heatGrid(start, end, (day) => {
    const v = values[day];
    let color = v ? palette[level(v, edges)] : EMPTY;
    const star = stars[day];
    const parts = star ? [star] : v ? [fmt(v, day)] : [];
    if (marks.has(day)) {
      color = v ? `linear-gradient(135deg, ${color} 50%, ${markColor} 50%)` : markColor;
      parts.push(markLabel);
    }
    if (star) color = starColor;
    return { color, tip: parts.join(" + ") || emptyTip, star: Boolean(star) };
  });
}

/** Colour scale legend. Optional [label, color] single swatches (swatch first, like every legend): `mark` after rest, `star` at the end. */
export function heatLegend(left, right, palette, { restLabel = null, mark = null, star = null } = {}) {
  const swatches = palette.map((c) => `<span class="sw" style="background:${c}"></span>`).join("");
  let rest = restLabel ? `<span class="sw" style="background:${EMPTY}"></span> ${restLabel}<span class="gap"></span>` : "";
  if (mark) rest += `<span class="sw" style="background:${mark[1]}"></span> ${mark[0]}<span class="gap"></span>`;
  const tail = star ? `<span class="gap"></span><span class="sw star" style="background:${star[1]}"></span> ${star[0]}` : "";
  return `<div class="legend">${rest}${left} ${swatches} ${right}${tail}</div>`;
}

/**
 * A key of single swatches, swatch first: items are [label, color, kind ("star" or null), key]. Items with a key
 * are buttons that hide/show that series (see series.js); the rest are plain labels.
 */
export function swatchLegend(...items) {
  return `<div class="legend">${items.map(([label, color, kind, key]) => {
    const body = `<span class="sw${kind === "star" ? " star" : ""}" style="background:${color}"></span> ${label}`;
    return key ? `<button type="button" class="li" data-s="${key}" aria-pressed="true">${body}</button>` : `<span class="lk">${body}</span>`;
  }).join('<span class="gap"></span>')}</div>`;
}
