// One floating tooltip for every heatmap cell and line-chart band: the elements carrying data-key (the day or the
// bucket's first day, ISO), data-date (its title) and data-tip (its text).
//
// The point under the mouse, or the tapped/clicked one, is "active": every panel highlights the same day / week /
// month / year (they all share one set of buckets) and writes its summary in its readout line, and the tooltip
// shows at the point itself, so one gesture answers "what was that week like" across every metric.
//   Mouse: hovering activates a point until the pointer leaves the charts; a click pins it (hovering then leaves
//   it alone) and the pinned tooltip follows its point while the page or a chart scrolls.
//   Touch: there is no hover (and a finger's pointerover would flash a tooltip at the start of every swipe), so
//   a tap pins instead. Taps are clicks, which never fire after a scroll or pan.
// Clicking or tapping the pinned point again, or anywhere that isn't a point or a button, unpins it. A pin
// survives re-renders (legend toggles, resizes, a horizon with the same bucket) and is dropped when no panel has
// that bucket any more.

let tip = null;
let pinned = null; // {key, panel}: the clicked or tapped point (panel: index of its section)
let hovered = null; // {key, panel}: the point under the mouse, while nothing is pinned
let anchor = null; // the element the tooltip is shown at

const view = () => document.getElementById("view");
const sections = () => [...view().querySelectorAll("section")];
const pointOf = (target) => (target.closest && target.closest("[data-key][data-tip]")) || null;
const refOf = (point) => ({ key: point.dataset.key, panel: sections().indexOf(point.closest("section")) });

function fill(el) {
  const date = document.createElement("div");
  date.className = "d";
  date.textContent = el.dataset.date;
  const value = document.createElement("div");
  value.textContent = el.dataset.tip;
  tip.replaceChildren(date, value);
}

/**
 * Position the tooltip by `el`, or hide it while `el` is off screen. A line-chart band spans the whole plot, so
 * the tooltip goes beside it, level with the plot's top (right of it, else left): above it would cover the panel's
 * headline. A heatmap cell, or a band with no room either side (phones), gets it above (below if there's no room).
 */
function place(el) {
  const r = el.getBoundingClientRect();
  if (!r.width || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
    tip.hidden = true;
    return;
  }
  tip.hidden = false;
  const t = tip.getBoundingClientRect();
  const clampX = (x) => Math.min(Math.max(8, x), innerWidth - t.width - 8);
  const right = r.right + 10, left = r.left - 10 - t.width;
  const besideFits = right + t.width <= innerWidth - 8 || left >= 8;
  if (el.classList.contains("hit") && besideFits) {
    tip.style.left = (right + t.width <= innerWidth - 8 ? right : left) + "px";
    tip.style.top = Math.min(Math.max(8, r.top), innerHeight - t.height - 8) + "px";
  } else {
    tip.style.left = clampX(r.left + r.width / 2 - t.width / 2) + "px";
    tip.style.top = (r.top - t.height - 8 < 8 ? r.bottom + 8 : r.top - t.height - 8) + "px";
  }
}

/** The point for `key` in the chart a section currently shows (its heatmap or its line chart, by mode). */
function pointIn(section, key) {
  const chart = [...section.querySelectorAll(".heat, .line")].find((c) => c.offsetParent !== null);
  return chart ? chart.querySelector(`[data-key="${key}"]`) : null;
}

/**
 * Show the active point (pinned, else hovered) everywhere: highlight its bucket in every panel that has it, fill
 * the readout lines and put the tooltip at the point in its own panel. Returns whether any panel had it.
 */
function mark() {
  const root = view();
  if (!root) return false;
  const active = pinned || hovered;
  for (const el of root.querySelectorAll(".sel")) el.classList.remove("sel");
  root.classList.toggle("pinned", Boolean(pinned));
  anchor = null;
  let found = false;
  sections().forEach((section, i) => {
    const el = active && pointIn(section, active.key);
    const readout = section.querySelector(".readout");
    // the summary only (data-sum, else the tip's first line): race names and times stay in the tooltip
    if (readout) readout.textContent = el ? `${el.dataset.date} · ${el.dataset.sum ?? el.dataset.tip.split("\n")[0]}` : "";
    if (!el) return;
    found = true;
    el.classList.add("sel");
    if (i === active.panel) anchor = el;
  });
  if (anchor) {
    fill(anchor);
    place(anchor);
  } else {
    tip.hidden = true;
  }
  return found;
}

/** Re-apply the pin after a render (main.js calls this); a hover is dropped, its elements were replaced. */
export function applySelection() {
  hovered = null;
  if (!mark() && pinned) {
    pinned = null; // no panel has that bucket any more (another horizon or granularity)
    mark();
  }
}

export function initTooltip(el) {
  tip = el;

  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse" || pinned) return;
    const point = pointOf(e.target);
    if (point) {
      const ref = refOf(point);
      if (hovered && hovered.key === ref.key && hovered.panel === ref.panel) return;
      hovered = ref;
    } else if (e.target.closest && e.target.closest(".grid, .chart")) {
      return; // keep it while crossing the gaps between cells or bands
    } else {
      if (!hovered) return;
      hovered = null;
    }
    mark();
  });
  document.documentElement.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse" || !hovered) return;
    hovered = null;
    mark();
  });

  let pointer = "mouse";
  document.addEventListener("pointerdown", (e) => { pointer = e.pointerType; }, true);
  document.addEventListener("click", (e) => {
    const point = pointOf(e.target);
    if (point) {
      const ref = refOf(point);
      const same = pinned && pinned.key === ref.key && pinned.panel === ref.panel;
      pinned = same ? null : ref;
      hovered = same && pointer === "mouse" ? ref : null; // unpinned under the mouse: back to hovering it
    } else if (e.target.closest && e.target.closest("button, a")) {
      return; // toolbar and legend buttons keep the pin (their re-render re-applies it)
    } else {
      if (!pinned) return;
      pinned = null;
    }
    mark();
  });

  // Scrolling the page or a chart: a pinned tooltip follows its point; a hover ends (the mouse is elsewhere now).
  document.addEventListener("scroll", () => {
    if (pinned) {
      if (anchor) place(anchor);
    } else if (hovered) {
      hovered = null;
      mark();
    }
  }, { capture: true, passive: true });
}
