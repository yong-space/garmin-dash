// Number and text formatting. Rounding is half-to-even, so values print the same as they did when the
// page was rendered in Python (e.g. 72.25 kg -> "72.2", not "72.3").

/** Round to an integer, ties to even. */
export function roundEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** x with n decimals, ties to even. */
export function fixed(x, n) {
  if (x < 0 || Object.is(x, -0)) return "-" + fixed(-x, n);
  let s = x.toFixed(n);
  const exact = x.toFixed(Math.min(100, n + 60)); // the exact decimal value (toFixed is exact, not shortest)
  const dot = exact.indexOf(".");
  if (/^50*$/.test(exact.slice(dot + 1 + n))) {
    // a true tie: toFixed rounded up; round down instead when that digit is already even
    const down = exact.slice(0, n ? dot + 1 + n : dot);
    if (Number(down[down.length - 1]) % 2 === 0) s = down;
  }
  return s;
}

/** fixed() with thousands separators: grouped(1234.4, 0) -> "1,234". */
export function grouped(x, n) {
  const [whole, frac] = fixed(x, n).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? "." + frac : "");
}

/** fixed() with an explicit sign: "+0.4", "-1.2". */
export function signed(x, n) {
  return x < 0 || Object.is(x, -0) ? fixed(x, n) : "+" + fixed(x, n);
}

/** Round to n decimals as a number (clears float noise such as 0.30000000000000004). */
export function roundTo(x, n) {
  return Number(fixed(x, n));
}

/** Compact number: up to 6 significant digits, no trailing zeros ("1.5", "60", "0.25"). */
export function compact(x) {
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const strip = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  const [mantissa, e] = x.toExponential(5).split("e");
  const exp = Number(e);
  if (exp < -4 || exp >= 6) return `${strip(mantissa)}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  return strip(x.toFixed(5 - exp));
}

/**
 * A run distance, everywhere it's shown: one decimal, thousands separators, and no decimal when it rounds to .0:
 * distance(1234.56, "km") -> "1,234.6 km", distance(9.96, "km") -> "10 km".
 */
export const distance = (x, unit) => `${grouped(x, 1).replace(/\.0$/, "")} ${unit}`;

/** Strength time in hours, everywhere it's shown: one decimal, none when it rounds to .0: hours(1.08) -> "1.1h",
 *  hours(0.98) -> "1h". */
export const hours = (h) => `${fixed(h, 1).replace(/\.0$/, "")}h`;

/** An axis tick: no trailing zeros, thousands separators ("1,500", "2.5", "0"). Pair with ticks of at most one
 *  decimal (axisTicks' `decimals`), so a tick never prints more precisely than the values it measures. */
export function tick(x) {
  const [whole, frac] = compact(x).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? "." + frac : "");
}

/** Minutes as "1h 05m" or "45m". */
export function hm(minutes) {
  const total = roundEven(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Seconds as a race clock: "1:02:03" or "45:07". */
export function clock(seconds) {
  const total = roundEven(seconds);
  const h = Math.floor(total / 3600);
  const rem = total % 3600;
  const mm = Math.floor(rem / 60);
  const ss = String(rem % 60).padStart(2, "0");
  return h ? `${h}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/** Seconds per km or mile as a pace, rounded to the second: pace(285.4) -> "4:45". */
export function pace(seconds) {
  const total = roundEven(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Escape text for use inside HTML text or attribute values. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[c]);
}
