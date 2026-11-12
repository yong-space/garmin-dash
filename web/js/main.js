// Entry point: fetch the chosen horizon's days, render them and wire up the toolbar. Each horizon fetches only its
// own range, and a horizon inside an already fetched range reuses it.
// The horizon, chart type and line granularity live in the URL (?h=3m&v=line&g=d), so a view can be bookmarked.

import { getDays } from "./api.js";
import { CHART_MODES, DEFAULT_HORIZON, GRANULARITIES, HORIZONS, LINE_ONLY_FALLBACK } from "./config.js";
import { iso, shortDate, today as getToday } from "./dates.js";
import { esc } from "./format.js";
import { updatePanHint } from "./heatmap.js";
import { snapColumns } from "./linechart.js";
import { renderPanels } from "./panels.js";
import { applySeries, initSeries } from "./series.js";
import { granularitiesFor } from "./stats.js";
import { initTheme } from "./theme.js";
import { applySelection, initTooltip } from "./tooltip.js";

const main = document.querySelector("main");
const view = document.getElementById("view");
const range = document.getElementById("range");
const horizonGroup = document.getElementById("horizons");
const granularityGroup = document.getElementById("granularity");
const modeButtons = [...document.querySelectorAll(".toggle.mode button[data-mode]")];

const today = getToday();
const phone = matchMedia("(max-width: 700px)"); // the CSS phone breakpoint
let data = null; // the current horizon's days, from its start (data.start) to today
let pending = null; // the start (ISO) of the range being fetched, if any
let panelWidth = 0; // px width of a panel as last measured; charts are drawn at it

const horizonOf = (key) => HORIZONS.find((h) => h.key === key);
const offered = (h) => granularitiesFor(h.start(today), today, Boolean(h.startsOnStart));
const keys = GRANULARITIES.map((g) => g.key);

/** `wanted` if the horizon offers it, else the offered granularity nearest the horizon's default. */
function granularityFor(h, wanted) {
  const ok = offered(h);
  if (ok.includes(wanted)) return wanted;
  const at = keys.indexOf(h.granularity);
  return ok.reduce((a, b) => (Math.abs(keys.indexOf(b) - at) < Math.abs(keys.indexOf(a) - at) ? b : a));
}

const params = new URLSearchParams(location.search);
const state = { mode: CHART_MODES.includes(params.get("v")) ? params.get("v") : CHART_MODES[0] };
state.horizon = horizonOf(params.get("h")) ? params.get("h") : DEFAULT_HORIZON;
if (state.mode === "heat" && horizonOf(state.horizon).lineOnly) state.horizon = LINE_ONLY_FALLBACK;
state.granularity = granularityFor(horizonOf(state.horizon), params.get("g"));

horizonGroup.innerHTML = HORIZONS.map((h) =>
  `<button type="button" data-horizon="${h.key}" aria-pressed="false"${h.lineOnly ? ' class="line-only"' : ""}>${h.label}</button>`
).join("");
const horizonButtons = [...horizonGroup.querySelectorAll("button")];
granularityGroup.innerHTML = GRANULARITIES.map((g) =>
  `<button type="button" data-granularity="${g.key}" title="${g.title}" aria-label="${g.title}" aria-pressed="false">${g.label}</button>`
).join("");
const granularityButtons = [...granularityGroup.querySelectorAll("button")];

function saveState() {
  const url = new URL(location.href);
  url.searchParams.set("h", state.horizon);
  url.searchParams.set("v", state.mode);
  url.searchParams.set("g", state.granularity);
  history.replaceState(null, "", url);
}

// Wide charts pan sideways on phones: start at the newest week, and again after switching view.
function scrollChartsToEnd() {
  for (const el of document.querySelectorAll(".hscroll, .lcs")) el.scrollLeft = el.scrollWidth;
  for (const el of document.querySelectorAll(".hscroll")) updatePanHint(el);
}

/** Re-measure the panel width; true if it changed (the charts then need redrawing). */
function measurePanel() {
  const width = view.querySelector("section")?.clientWidth || 0;
  if (!width || width === panelWidth) return false;
  panelWidth = width;
  return true;
}

// Anything that changes chart size or visibility: re-snap columns to the pixel grid, then re-pan.
function afterLayout() {
  snapColumns(view);
  scrollChartsToEnd();
}

function showMode() {
  main.dataset.mode = state.mode;
  for (const b of modeButtons) b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
  requestAnimationFrame(afterLayout);
}

/** Sync the toolbar with the state: pressed buttons, the granularities this horizon offers, the date range. */
function showToolbar(horizon, start) {
  for (const b of horizonButtons) b.setAttribute("aria-pressed", String(b.dataset.horizon === state.horizon));
  const ok = offered(horizon);
  for (const b of granularityButtons) {
    b.hidden = !ok.includes(b.dataset.granularity);
    b.setAttribute("aria-pressed", String(b.dataset.granularity === state.granularity));
  }
  range.textContent = `${shortDate(start)} – ${shortDate(today)}`;
}

function render() {
  const horizon = horizonOf(state.horizon);
  const start = horizon.start(today);
  showToolbar(horizon, start);
  const from = iso(start);
  if (!data || data.start !== from) return load(from);
  pending = null; // back on a horizon that's loaded: a slower fetch for another one no longer applies
  view.removeAttribute("aria-busy");
  const draw = () => {
    view.innerHTML = renderPanels(start, today, data, {
      granularity: state.granularity,
      keepPartialFirst: Boolean(horizon.startsOnStart),
      heat: !horizon.lineOnly,
      panelWidth,
      phone: phone.matches,
    });
  };
  draw();
  if (measurePanel()) draw(); // the panel width depends on the layout just drawn: redraw the charts at it
  applySeries(view);
  requestAnimationFrame(() => { afterLayout(); applySelection(); }); // after layout, so a pinned tooltip is placed right
}

/** Fetch the days from `from` to today, then render; the current charts stay up, dimmed, until they arrive. */
function load(from) {
  if (pending === from) return;
  pending = from;
  view.setAttribute("aria-busy", "true");
  getDays(from, iso(today)).then(
    (d) => {
      if (pending !== from) return; // the horizon changed while this was loading
      data = d;
      render();
    },
    (err) => {
      if (pending !== from) return;
      pending = null;
      view.removeAttribute("aria-busy");
      view.innerHTML = `<p class="status error">Couldn't load data: ${esc(err.message)}</p>`;
    },
  );
}

/** Switch horizon; the granularity resets to the new horizon's default. */
function setHorizon(key) {
  state.horizon = key;
  state.granularity = granularityFor(horizonOf(key), horizonOf(key).granularity);
}

horizonGroup.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-horizon]");
  if (!b || b.dataset.horizon === state.horizon) return;
  setHorizon(b.dataset.horizon);
  saveState();
  render();
});
granularityGroup.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-granularity]");
  if (!b || b.dataset.granularity === state.granularity) return;
  state.granularity = b.dataset.granularity;
  saveState();
  render();
});
for (const b of modeButtons) {
  b.addEventListener("click", () => {
    if (b.dataset.mode === state.mode) return;
    state.mode = b.dataset.mode;
    if (state.mode === "heat" && horizonOf(state.horizon).lineOnly) setHorizon(LINE_ONLY_FALLBACK); // no heatmap
    saveState();
    showMode();
    render(); // each mode has its own panel layout, so the line charts may need redrawing at a new width
  });
}
addEventListener("resize", () => {
  if (data && measurePanel()) render(); // charts are drawn at the panel's width
  else afterLayout();
});
initTheme(document.getElementById("theme"));
initTooltip(document.getElementById("tip"));
initSeries(render);
saveState(); // write back a corrected URL (an unknown or unavailable horizon or granularity)
showMode();
render();
