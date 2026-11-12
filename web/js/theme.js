// Light/dark theme. Until the button by the title is first used, the page follows the device's preference; from
// then on it uses the theme picked with the button (remembered per browser when storage is available) and ignores
// the device. The script in index.html's <head> applies the same rule before first paint, so the page never flashes
// the wrong theme; the colours themselves are in css/theme.css.

const KEY = "theme";
const deviceDark = matchMedia("(prefers-color-scheme: dark)");

let picked; // "light" or "dark" once the button has been used, else null
try { picked = localStorage.getItem(KEY); } catch { picked = null; }
if (picked !== "light" && picked !== "dark") picked = null;

const current = () => picked ?? (deviceDark.matches ? "dark" : "light");

function apply(button) {
  const theme = current();
  document.documentElement.dataset.theme = theme;
  const label = `Switch to ${theme === "dark" ? "light" : "dark"} theme`;
  button.title = label;
  button.setAttribute("aria-label", label);
}

/** Wire up the theme button; call once. */
export function initTheme(button) {
  apply(button);
  deviceDark.addEventListener("change", () => { if (!picked) apply(button); }); // ignored once a theme is picked
  button.addEventListener("click", () => {
    picked = current() === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, picked); } catch {}
    apply(button);
  });
}
