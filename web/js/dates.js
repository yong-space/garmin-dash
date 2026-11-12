// Calendar days as Date objects at UTC midnight, so day arithmetic never trips over DST.

const DAY_MS = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const parseDay = (s) => new Date(s + "T00:00:00Z");
export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
export const daysBetween = (a, b) => Math.round((b - a) / DAY_MS); // b - a
export const sameDay = (a, b) => a.getTime() === b.getTime();
export const weekday = (d) => (d.getUTCDay() + 6) % 7; // Monday = 0
export const mondayOf = (d) => addDays(d, -weekday(d)); // start of d's Monday-start week

/** Today in the viewer's time zone. */
export function today() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function* daterange(start, end) {
  for (let d = start; d <= end; d = addDays(d, 1)) yield d;
}

/** The same day of the month `n` months earlier, clamped to that month's length. */
export function monthsAgo(d, n) {
  const index = d.getUTCFullYear() * 12 + d.getUTCMonth() - n;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const monthLength = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), monthLength)));
}

export const monthName = (d) => MONTHS[d.getUTCMonth()]; // "Nov"
export const shortDate = (d) => `${monthName(d)} ${d.getUTCDate()}`; // "Nov 8"
export const longDate = (d) => `${WEEKDAYS[weekday(d)]} ${shortDate(d)}`; // "Sun Nov 8"
