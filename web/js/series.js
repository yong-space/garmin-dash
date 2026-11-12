// Legend buttons show/hide a series for that chart (the nearest data-m) on every horizon; the choice is
// remembered per browser when storage is available. Lines are hidden with CSS (an off-sN class on the chart);
// stacked columns and the run heatmap are redrawn without the hidden series (see hiddenSeries), so a toggle
// triggers a re-render. Two charts with the same data-m share their choices.

const KEY = "hidden-series";
let hidden;
try { hidden = new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch { hidden = new Set(); }

/** The series keys ("s0", "sr", "race", …) switched off for one chart. */
export function hiddenSeries(chart) {
  return new Set([...hidden].filter((id) => id.startsWith(chart + ":")).map((id) => id.slice(chart.length + 1)));
}

/** Sync legend buttons and chart visibility with the remembered choices; call after each render. */
export function applySeries(root = document) {
  for (const box of root.querySelectorAll("[data-m]")) {
    for (const b of box.querySelectorAll("button[data-s]")) {
      const off = hidden.has(box.dataset.m + ":" + b.dataset.s);
      box.classList.toggle("off-" + b.dataset.s, off);
      b.setAttribute("aria-pressed", String(!off));
    }
  }
}

/**
 * Legend hover (or keyboard focus): keep that series at full strength and fade the rest of its chart. Chart marks
 * carry data-k with their series key(s); axes and labels don't, so they stay put.
 */
let focused = null;
function focusSeries(button) {
  if (button === focused) return;
  if (focused) {
    const box = focused.closest("[data-m]");
    box?.classList.remove("focusing");
    for (const el of box?.querySelectorAll("[data-k].on") || []) el.classList.remove("on");
  }
  focused = button;
  if (!button || button.getAttribute("aria-pressed") === "false") return; // a hidden series has nothing to show
  const box = button.closest("[data-m]");
  for (const el of box.querySelectorAll(`[data-k~="${button.dataset.s}"]`)) el.classList.add("on");
  box.classList.add("focusing");
}
const legendButton = (e) => (e.target.closest && e.target.closest("[data-m] .legend button[data-s]")) || null;
document.addEventListener("pointerover", (e) => focusSeries(legendButton(e)));
document.addEventListener("focusin", (e) => focusSeries(legendButton(e)));
document.addEventListener("focusout", () => focusSeries(null));

// Touch has no hover, so a long press on a legend entry is the highlight: no context menu, and letting go doesn't
// also count as a tap that hides the series. The text selection and iOS callout are switched off in CSS.
const LONG_PRESS_MS = 400;
let pressed = null; // { button, at } for the touch/pen press in progress
let longPressed = null; // the legend button whose press just ended as a long press, so its click is skipped
document.addEventListener("contextmenu", (e) => { if (legendButton(e)) e.preventDefault(); });
document.addEventListener("pointerdown", (e) => {
  longPressed = null;
  pressed = e.pointerType !== "mouse" && legendButton(e) ? { button: legendButton(e), at: e.timeStamp } : null;
});
document.addEventListener("pointerup", (e) => {
  if (pressed && e.timeStamp - pressed.at >= LONG_PRESS_MS) longPressed = pressed.button;
  pressed = null;
});
document.addEventListener("pointercancel", () => { pressed = null; });

/** onChange: called after a toggle (main.js re-renders, so stacked columns close up). */
export function initSeries(onChange = applySeries) {
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-m] button[data-s]");
    if (!b) return;
    if (b === longPressed) { longPressed = null; return; } // a long press highlights; it doesn't toggle
    const id = b.closest("[data-m]").dataset.m + ":" + b.dataset.s;
    hidden.has(id) ? hidden.delete(id) : hidden.add(id);
    try { localStorage.setItem(KEY, JSON.stringify([...hidden])); } catch {}
    focused = null; // the chart is redrawn
    onChange();
  });
}
